'use strict';

var fs = require('fs');
var util = require('util');

var Bitcoin = require('bitcoinjs-lib');
var CryptoJS = require('crypto-js');
var GAConnection = require('./greenaddress');
var async = require('async');

var SATOSHI_FACTOR = 1e8;
var TRANSACTION_FEE = 10000;  // in satoshis

var GreenAddress = function(config) {
  this.config = config;

  this.conn = new GAConnection(config.ws_url, config.token_url, config.additional_accounts);
  this.hdwallet = this.conn.hdwallet = config.hdwallet;
  this.accounts = this.conn.accounts;

  this.testMode = false;
  // Leave this much in account, to leave enough to cover transaction fee
  this.TRANSACTION_FEE_MARGIN = 3 * TRANSACTION_FEE;

  // Number of outputs to split an incoming transaction into, per transaction
  this.PER_TRANSACTION_SPLIT_COUNT = 20;

  // Expected maximum time for a block to complete, in minutes
  this.EXPECTED_MAX_BLOCK_TIME = 60;

  // Expected transactions per minute
  this.EXPECTED_TRANSACTION_RATE = 2;

  // The max number of transactions we expect per block confirmation
  // For now this MUST be a multiple of PER_TRANSACTION_SPLIT_COUNT
  this.SPLIT_COUNT = this.EXPECTED_MAX_BLOCK_TIME * this.EXPECTED_TRANSACTION_RATE;
  console.assert(this.SPLIT_COUNT % this.PER_TRANSACTION_SPLIT_COUNT === 0);
  this.SPLIT_TRANSACTION_COUNT = this.SPLIT_COUNT / this.PER_TRANSACTION_SPLIT_COUNT;

  // An account is considered empty if it has less than this amount in it
  this.EPSILON = 2 * this.TRANSACTION_FEE_MARGIN * this.SPLIT_TRANSACTION_COUNT;

  this.poolAccount = config.poolAccount;

  this.q = async.queue(function(task, cb) {
    task(cb);
  }, 1);
};

var EventEmitter = require('events').EventEmitter;
util.inherits(GreenAddress, EventEmitter);
module.exports = GreenAddress;

GreenAddress.factory = function factory(config) {
  return new GreenAddress(config);
};

GreenAddress.prototype._sendFrom = function(src, address, satoshis, confirmations, callback) {
  var self = this;
  var src_num = this.accounts[src];
  self.q.push(function(cb) {
    self.conn.loginCall('http://greenaddressit.com/vault/prepare_tx', satoshis, address, 'sender',
        {'subaccount': src_num}).then(function(data) {
      try {
        self._sign_and_send_tx(src_num, data).then(function(txid) {
          cb(null, txid);
        }, cb);
      } catch (e) {
        cb(e);
      }
    }, function(e) {
      if (e.uri === "http://greenaddressit.com/error#notenoughmoney") 
        return cb(richError('Insufficient funds', 'InsufficientFunds'));
      cb(e.desc);
    });
  }, callback);
}


GreenAddress.prototype.sendBitcoins = function sendBitcoins(address, satoshis, transactionFee, cb) {
  var confirmations = 1;
  this._sendFrom(this.poolAccount, address, satoshis, confirmations, cb);
};


GreenAddress.prototype.balance = function balance(cb) {
  this._accountBalance(this.poolAccount, 1, cb);
};


GreenAddress.prototype._isEmptyBalance = function _isEmptyBalance(balance) {
  return balance < this.EPSILON;
};

GreenAddress.prototype._accountBalance = function accountBalance(account, confs, cb) {
  this._getBalance(account, cb);
};

GreenAddress.prototype.monitorAccount = function monitorAccount(account, cb) {
  var self = this;
  var confs = this.testMode ? 0 : 1;
  this._accountBalance(account, confs, function (err, balance) {
    if (err) {
      self.emit('error', err);
      return cb && cb(err);
    }
    if (self._isEmptyBalance(balance)) return cb && cb(null, null);
    self.emit('funded', account, balance);
    self._splitAccount(account, balance, function (err, txIds) {
      if (err) return cb && cb(err);
      cb(null, balance, txIds);
    });
  });
};

GreenAddress.prototype.addressReceived = function addressReceived(address, confs, cb) {
  this.conn.loginCall('http://greenaddressit.com/txs/get_balance_by_addr', address).then(function(data) {
    cb(null, parseInt(data.satoshi, 10));
  }, function(err) {
    cb(err.desc);
  });
};

GreenAddress.prototype.newAddress = function newAddress(account, cb) {
  this.conn.loginCall('http://greenaddressit.com/vault/fund', this.accounts[account]).then(function(script) {
    try {
      var script = Bitcoin.convert.bytesToWordArray(Bitcoin.convert.hexToBytes(script));
      var hash = Bitcoin.convert.wordArrayToBytes(CryptoJS.RIPEMD160(CryptoJS.SHA256(script)));
      var version = Bitcoin.network['testnet'].p2shVersion;
      var address = new Bitcoin.Address(hash, version);
    } catch (e) {
      cb(e);
      return;
    }
    cb(null, address.toString());
  }, cb);
};

GreenAddress.prototype._sendMany = function(src, addressMap, confirmations, callback) {
  var self = this;
  var src_num = this.accounts[src];
  var values = [], addresses = [];
  for (var address in addressMap) {
    addresses.push(address);
    values.push(addressMap[address]);
  }

  self.q.push(function(cb) {
    self.conn.loginCall('http://greenaddressit.com/vault/prepare_tx', values, addresses, 'sender',
        {'subaccount': src_num}).then(function(data) {
      try {
        self._sign_and_send_tx(src_num, data).then(function(txid) {
          cb(null, txid);
        }, cb);
      } catch (e) {
        cb(e);
      }
    }, function(e) {
      if (e.uri === "http://greenaddressit.com/error#notenoughmoney") 
        return cb(richError('Insufficient funds', 'InsufficientFunds'));
      cb(e.desc);
    });
  }, callback);
}

GreenAddress.prototype._sendSplitTransaction = function _sendSplitTransaction(account, addresses, totalSatoshis, cb) {
  var count = addresses.length;
  var eachSatoshis = Math.floor(totalSatoshis / count);
  var firstSatoshis = eachSatoshis + totalSatoshis % count;
  
  var addressMap = {};
  addresses.forEach(function (address, index) {
    var satoshis = index === 0 ? firstSatoshis : eachSatoshis;
    addressMap[address] = satoshis;
  });

  var confs = this.testMode ? 0 : 1;
  this._sendMany(account, addressMap, confs, function (err, txId) {
    if (err) return cb(new Error(err));
    cb(null, txId);
  });    
};

GreenAddress.prototype._splitAccountTransaction = function _splitAccountTransaction(account, satoshis, cb) {
  var self = this;
  function newAddressFunc(i, next) {
    self.newAddress(self.poolAccount, function (err, address) {
      if (err) return next(err);
      next(null, address);
    });
  }

  async.times(this.PER_TRANSACTION_SPLIT_COUNT, newAddressFunc, function (err, addresses) {
    if (err) return cb(err);
    self._sendSplitTransaction(account, addresses, satoshis, function(err, txId) {
      if (err) return cb(err);
      cb(null, txId);
    });
  });
};

GreenAddress.prototype._splitAccount = function _splitAccount(account, balance, cb) {
  var perTransactionSatoshis = 
    Math.floor(balance / this.SPLIT_TRANSACTION_COUNT) - this.TRANSACTION_FEE_MARGIN;

  var self = this;
  function splitFunc(index, next) {
    self._splitAccountTransaction(account, perTransactionSatoshis, function (err, txId) {
      next(err, txId);
    });
  }

  async.times(this.SPLIT_TRANSACTION_COUNT, splitFunc, function (err, txIds) {
    if (err) return cb(err);
    cb(null, txIds);
  });
};

GreenAddress.prototype._getBalance = function(account, cb) {
  this.conn.loginCall('http://greenaddressit.com/txs/get_balance', this.accounts[account]).then(function(data) {
    cb(null, parseInt(data.satoshi, 10));
  }, function(err) {
    cb(err.desc);
  });
}

GreenAddress.prototype._sign_and_send_tx = function (account, data) {
    var tx = Bitcoin.Transaction.deserialize(data.tx);
    var signatures = [];
    for (var i = 0; i < tx.ins.length; ++i) {
        if (data.prev_outputs[i].privkey) {
            var key = data.prev_outputs[i].privkey;
        } else {
            var key = this.hdwallet;
            key = key.derive(data.prev_outputs[i].branch);
            if (account) {
              key = key.derivePrivate(account);
            }
            key = key.derive(data.prev_outputs[i].pointer);
            key = key.priv;
        }
        var script = new Bitcoin.Script(Bitcoin.convert.hexToBytes(data.prev_outputs[i].script));
        var SIGHASH_ALL = 1;
        var sign = key.sign(tx.hashTransactionForSignature(script, i, SIGHASH_ALL));
        sign.push(SIGHASH_ALL);
        signatures.push(Bitcoin.convert.bytesToHex(sign));
    }
    return this.conn.loginCall("http://greenaddressit.com/vault/send_tx", signatures, null);
}

GreenAddress.prototype._move = function(src, dst, satoshis, callback) {
  var src_num = this.accounts[src],
      self = this;
  async.waterfall([
    function(cb) { self.newAddress(dst, cb); },
    function(addr, callback) {
      self.q.push(function(cb) {
        self.conn.loginCall('http://greenaddressit.com/vault/prepare_tx', satoshis, addr, 'recipient',
            {'subaccount': src_num}).then(function(data) {
          try {
            self._sign_and_send_tx(src_num, data).then(function(data) {
              cb();
            }, cb);
          } catch (e) {
            cb(e);
          }
        }, cb);
      }, callback);
    }
  ], function(err) {
    callback(err);    
  });
}