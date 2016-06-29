import {Apis} from "graphenejs-ws";
import {Signature} from "graphenejs-lib";
import TransactionConfirmActions from "actions/TransactionConfirmActions";
import TransactionConfirmStore from "stores/TransactionConfirmStore";
import WalletUnlockActions from "actions/WalletUnlockActions";
import WalletDb from "stores/WalletDb";
import WalletApi from "../rpc_api/WalletApi";

var alt = require("../alt-instance");
var WebSocketClient = require("ReconnectingWebSocket");
var WebSocketRpc = require("rpc_api/WebSocketRpcServer");
var ConnectActions = require('actions/ConnectActions');
var AccountStore = require("stores/AccountStore");

// Zip function taken from http://stackoverflow.com/a/10284006/1431857
var zip= rows=>rows[0].map((_,c)=>rows.map(row=>row[c]));

class ConnectionStore {

    constructor() {
        this.errorMessage = null;
        this.ws_rpc = null;

        this.bindListeners({
            connect: ConnectActions.CONNECT
        });

        this.exportPublicMethods({
            connect: this.connect,
            getAccountId: this.getAccountId,
            getObjectById: this.getObjectById,
            getAssetBySymbol: this.getAssetBySymbol,
            getAllAssets: this.getAllAssets,
            getAccountByName: this.getAccountByName,
            getAccountBalances: this.getAccountBalances,
            getAccountHistory: this.getAccountHistory,
            getAccountHistoryByOpCode: this.getAccountHistoryByOpCode,
            getTransactionFees: this.getTransactionFees,
            getMyAccounts: this.getMyAccounts,
            signJsonObject: this.signJsonObject,
            broadcastTransaction: this.broadcastTransaction,
            isConnected: this.isConnected,
            _registerApi: this._registerApi
        });
    }

    connect(connection_string) {
        if (this.ws_rpc) return; // already connected
        console.log(`connecting to ${connection_string}`);
        this.ws_rpc = new WebSocketRpc();
        this._registerApi();
        this.ws_rpc.setSocket(new WebSocketClient(connection_string));
        return this.ws_rpc;
    }
    
    isConnected() {
        return this.ws_rpc;
    }

    close() {
        this.ws_rpc.close();
        this.ws_rpc = null
    }

    getAccountId(accountNameOrId) {
        let dbApi = Apis.instance().db_api();
        return new Promise(accept => {
            // If we have an account name, look up its ID
            if (accountNameOrId[0] === '1')
                accept(accountNameOrId);
            else
                dbApi.exec("get_account_by_name", [accountNameOrId]).then(account => {
                    accept(account.id);
                });
        });
    }

    getObjectById(objectId) {
        return Apis.instance().db_api().exec("get_objects", [[objectId]]).then(objects => {return objects[0];});
    }
    
    getAssetBySymbol(assetSymbol) {
        return Apis.instance().db_api().exec("lookup_asset_symbols", [[assetSymbol]]).then(objects => {
            return objects[0];
        });
    }

    getAllAssets() {
        let assets = [];
        let dbApi = Apis.instance().db_api();
        return new Promise(resolve => {
            let fetchMore = lowerBound => {
                dbApi.exec("list_assets", [lowerBound, 100]).then(list => {
                    assets = assets.concat(list);
                    if (list.length >= 100) {
                        fetchMore(list[list.length - 1].symbol);
                    } else {
                        resolve(_.uniq(assets.map(asset => {
                            return {
                                id: asset.id, symbol: asset.symbol,
                                precision: asset.precision, issuer: asset.issuer
                            };
                        })));
                    }
                });
            };
            fetchMore("");
        }).then(assets => {
            // Look up issuer accounts
            return dbApi.exec("get_accounts", [assets.map(asset => { return asset.issuer; })]);
        }).then(accounts => {
            // Replace issuer IDs with account names
            return zip([assets, accounts]).map(assetAccount => {
                assetAccount[0].issuer = assetAccount[1].name;
                return assetAccount[0];
            });
        }).catch(error => {console.log(error); throw error;});
    }
    
    getAccountByName(accountName) {
        let db = Apis.instance().db_api();
        return db.exec("get_account_by_name", [accountName]);
    }

    getAccountBalances(accountNameOrId) {
        let db = Apis.instance().db_api();
        return this.getAccountId(accountNameOrId).then(accountId => {
            return db.exec("get_account_balances", [accountId, []]);
        }).then(balances => {
            return balances.map(balance => {
                return {amount: balance.amount, type: balance.asset_id};
            });
        });
    }

    getAccountHistory(accountNameOrId) {
        let history = [];
        let historyApi = Apis.instance().history_api();
        
        this.getAccountId(accountNameOrId).then(accountId => {
            let fetchMore = lowerBound => {
                historyApi.exec("get_account_history", [accountId, "1.11.0", 100, lowerBound]).then(list => {
                    history = history.concat(list);
                    if (list.length >= 100) {
                        fetchMore(list[list.length - 1].id);
                    } else {
                        return (_.uniq(history.map(historyObject => {
                            return {id: historyObject.id, opCode: historyObject.op[0]};
                        })));
                    }
                });
            };
            fetchMore("1.11.0");
        });
    }

    getAccountHistoryByOpCode(accountNameOrId, opCode) {
        return this.getAccountHistory(accountNameOrId).then(history => {
            return history.filter(operation => {return operation.opCode === opCode;})
                          .map(operation => {return operation.id;});
        });
    }

    getTransactionFees(operations) {
        let dbApi = Apis.instance().db_api();
        // Convert operations to the format expected by database API
        let ops = operations.map(op => {
            delete op.op.fee;
            return [op.code, op.op];
        });
        return dbApi.exec("get_required_fees", [ops, "1.3.0"]).then(fees => {
            // Inject the fees back into the original operations, and return them
            return zip([operations, fees]).map(opFee => {
                opFee[0].op.fee = opFee[1];
                return opFee[0];
            });
        });
    }
    
    getMyAccounts() {
        return new Promise(resolve => {
            // FIXME: how do I wait for AccountStore to be loaded? The timeout pretty much always works for me, but it's
            // a race condition, pure and simple.
            setTimeout(function() {
                resolve(AccountStore.getMyAccounts());
            }, 3000);
        });
    }

    signJsonObject(object, signingAccountName) {
        return WalletUnlockActions.unlock().then(() => {
            if (!signingAccountName)
                throw "Missing signing account name";
            // Only sign something that's at least kind of human readable
            if (typeof(object) !== "string" || typeof(JSON.parse(object)) !== "object")
                throw "Refusing to sign value which is not a JSON object";
            // TODO: Display a prompt showing the user the object to sign and confirm that they're willing to sign it
            return this.getAccountByName(signingAccountName);
        }).then(account => {
            if (!account)
                throw "No such account found: " + signingAccountName;
            let memoPublicKey = account.options.memo_key;
            let memoPrivateKey = WalletDb.getPrivateKey(memoPublicKey);
            if (!memoPrivateKey) {
                throw "Wallet does not have private memo key for " + signingAccountName;
            }
            console.log(memoPrivateKey);

            return Signature.sign(object, memoPrivateKey).toHex();
        });
    }

    broadcastTransaction(operations) {
        return new Promise((resolve, reject) => {
            let wallet_api = new WalletApi();
            let trx = wallet_api.new_transaction();
            let trxListener = function(state) {
                if (state.error) {
                    reject(state.error);
                    TransactionConfirmStore.unlisten(trxListener);
                    return;
                }
                if (state.transaction === trx && state.broadcast) {
                    resolve(trx.id());
                    TransactionConfirmStore.unlisten(trxListener);
                    return;
                } else {
                    console.log("Nope", state.transaction, trx);
                }
            };
            
            _.forEach(operations, function (op) {
                trx.add_operation([op.code, op.op]);
            });
            WalletDb.process_transaction(trx, null, false).then(() => {
                TransactionConfirmStore.listen(trxListener);
                return TransactionConfirmActions.confirm(trx);
            });
        });

    }

    _registerApi() {
        this.ws_rpc.expose('blockchain', {
            getObjectById: this.getObjectById,
            getAssetBySymbol: this.getAssetBySymbol,
            getAllAssets: this.getAllAssets,
            getAccountByName: this.getAccountByName,
            getAccountBalances: this.getAccountBalances,
            getAccountHistory: this.getAccountHistory,
            getAccountHistoryByOpCode: this.getAccountHistoryByOpCode,
            getTransactionFees: this.getTransactionFees
        }, this);
        this.ws_rpc.expose('wallet', {
            getMyAccounts: this.getMyAccounts,
            signJsonObject: this.signJsonObject,
            broadcastTransaction: this.broadcastTransaction
        }, this);
    }

}

module.exports = alt.createStore(ConnectionStore, 'ConnectionStore');