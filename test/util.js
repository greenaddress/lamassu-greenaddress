'use strict';
var Bitcoin = require('bitcoinjs-lib');
var CryptoJS = require('crypto-js');
var async = require('async');
var when = require('when');

var sign_and_send_tx = function (conn, hdwallet, account, data) {
    var tx = Bitcoin.Transaction.deserialize(data.tx);
    var signatures = [];
    for (var i = 0; i < tx.ins.length; ++i) {
        if (data.prev_outputs[i].privkey) {
            var key = data.prev_outputs[i].privkey;
        } else {
            var key = hdwallet;
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
    return conn.call("http://greenaddressit.com/vault/send_tx", signatures, null);
}

var sweep_account_to_account = function (conn, hdwallet, src_account, dst_account) {
	async.waterfall([
		function(cb) {
			conn.call('http://greenaddressit.com/txs/get_balance', src_account).then(function(balance) {
				conn.call('http://greenaddressit.com/vault/fund', dst_account).then(function(script) {
					var script = Bitcoin.convert.bytesToWordArray(Bitcoin.convert.hexToBytes(script));
					var hash = Bitcoin.convert.wordArrayToBytes(CryptoJS.RIPEMD160(CryptoJS.SHA256(script)));
	                var version = Bitcoin.network['testnet'].p2shVersion;
	                var address = new Bitcoin.Address(hash, version);
	                console.log(address.toString());
					cb(null, balance.satoshi, address.toString());
				}, cb);
			}, cb);
		},
		function(balance, addr, cb) {
			if (balance != '0') {
				conn.call('http://greenaddressit.com/vault/prepare_tx', balance, addr, 'recipient',
						{'subaccount': src_account}).then(function(data) {
					try {
						sign_and_send_tx(conn, hdwallet, src_account, data).then(function(data) {
							console.log(data);
							cb();
						}, cb);
					} catch (e) {
						cb(e);
					}
				}, cb);
			} else {
				cb();
			}
		}
	], function(err) {
		if (err) {
			console.error(err);
		}
	});
}

module.exports = {
	sweep_account_to_account: sweep_account_to_account
}