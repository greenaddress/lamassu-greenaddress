'use strict';

var wallet  = require('./wallet');
var BIP39   = require('bip39');
var Bitcoin = require('bitcoinjs-lib');
var _       = require('lodash');

exports.NAME = 'GreenAddress';
exports.SUPPORTED_MODULES = ['wallet'];

var pluginConfig = {
  ws_url: 'wss://prodwss.greenaddress.it/ws/inv/',
  token_url: 'https://greenaddress.it/token/',
  network: 'mainnet',
  poolAccount: 'funding'  // hardcoded in lib/greenaddress.js to 'main' account
}, ga;

exports.config = function config(localConfig) {
  if (localConfig) _.merge(pluginConfig, localConfig);
  var bip39 = new BIP39();
  pluginConfig.seed = bip39.mnemonicToSeed(pluginConfig.guid);
  pluginConfig.hdwallet = Bitcoin.HDWallet.fromSeedHex(pluginConfig.seed, pluginConfig.network);
  ga = new wallet(pluginConfig);
};

exports.balance = function balance(callback) {
  ga.balance(function(error, satoshis) {
    if (error) callback(error);
    else callback(null, {BTC: satoshis});
  });
}

exports.sendBitcoins = function sendBitcoins(address, satoshis, fee, callback) {
  ga._sendFrom(pluginConfig.poolAccount, address, satoshis, null, false, function(e, txhash) {
    if (e) { console.log('ERROR: sending coins: ' + JSON.stringify(e)); callback(e); }
    else { callback(null, txhash) }
  });
}
