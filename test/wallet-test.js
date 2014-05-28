'use strict';

var async = require('async');
var assert = require('chai').assert;

var BIP39 = require('bip39');
var Bitcoin = require('bitcoinjs-lib');
var GreenAddress = require('../lib/wallet.js');

describe('GreenAddress', function() {
  var gait = null;
  before(function () {
    var mnemonic = 'invite often tiny staff depend stove wave day august maid tonight exclude denial vast keep dragon dilemma gossip sample coil kick frost lion nice';
    var cur_net = 'testnet';  // 'mainnet' for main net
    var bip39 = new BIP39();
    //var seed = bip39.mnemonicToSeed(mnemonic);  // this is slow, perhaps move to a webworker
    //console.log(seed);
    var seed = '8cbc3ecbc23a398838ab18a45d0260fc8297e22458286b25e3c672e25f7853248a946c4673430f3e23d82db19a80632726412bf1521c4b657ad6ad8501950a2f';
    var hdwallet = Bitcoin.HDWallet.fromSeedHex(seed, cur_net);

    gait = GreenAddress.factory({ws_url: 'wss://testwss.greenaddress.it/ws/inv',
                                 hdwallet: hdwallet});
    gait.testMode = true;
    gait.PER_TRANSACTION_SPLIT_COUNT = 3;
    gait.SPLIT_COUNT = 6;
    gait.SPLIT_TRANSACTION_COUNT = 2;
    gait.EPSILON = 2 * gait.TRANSACTION_FEE_MARGIN * gait.SPLIT_TRANSACTION_COUNT;
  });

  // Move everything in funding account back to stash account
  beforeEach(function (done) {
    async.series([
      function(cb) {
        // create accounts with additional 'stash' and 'testAccount' accounts
        gait.makeAccounts(cb, [[10, 'stash'], [11, 'testAccount']]);
      },
      function() {
        gait._getBalance('funding', /* 0, */ function (err, balance) {
          if (err) throw err;
          if (balance === 0) return done();
          gait._move('funding', 'stash', balance, /* 0, */ function (err) {
            if (err) throw err;
            done();
          });
        });
      }
    ],
    function(err) {
      assert.isNull(err);
      done();
    });
    
  });

  afterEach(function () {
    gait.removeAllListeners();
  });

  describe('#newAddress', function () {
    it('should return a valid Bitcoin address', function(done) {
      gait.newAddress('testAccount', function (err, addr) {
        try {
          assert.isNull(err);
          new Bitcoin.Address(addr)
        } catch (e) {
          return done(e);
        }
        done();
      });
    });
  });

  describe('#addressReceived', function() {
    it('should return 0 satoshis for a new address', function(done) {
      gait.newAddress('testAccount', function (err, addr) {
        gait.addressReceived(addr, 0, function (err, satoshis) {
          try {
            assert.isNull(err);
            assert.equal(satoshis, 0);
          } catch (e) { return done(e); }
          done();
        });
      });
    });

    it('should return an error for bad address', function(done) {
      gait.addressReceived('bogus', 0, function (err) {
        try {
          assert.isNotNull(err);
          assert.equal(err, "Internal Error");
        } catch (e) { return done(e); }
        done();
      });
    });

    it('should return zero for non-existant address', function(done) {
      gait.addressReceived('moKFmN5DtxKpFwnJ3vULBjuGxaVKMB6tG3', 0, function (err, satoshis) {
        try {
          assert.isNull(err);
          assert.equal(satoshis, 0);
        } catch (e) { return done(e); }
        done();
      });
    });

    it('should return the correct amount in satoshis', function(done) {
      var bitcoinAmount = 0.001;
      var satoshiAmount = Math.round(bitcoinAmount * 1e8);
      gait.newAddress('testAccount', function (err, addr) {
        gait._sendFrom('stash', addr, satoshiAmount, 0, function (err) {
          if (err) return done(err);
          gait.addressReceived(addr, 0, function (err, satoshis) {
            try {
              assert.isNull(err);
              assert.equal(satoshis, satoshiAmount);
            } catch (e) { return done(e); }
            done();
          });
        });
      });
    });

  });

  describe('#monitorAccount', function() {
    it('should do nothing on empty account', function(done) {
      gait.once('error', function () {
        assert.fail('shouldn\'t have errored');
      });
      gait.once('funded', function () {
        assert.fail('funding account should be empty');
      });
      gait.monitorAccount('empty', function (err, balance) {
        assert.isNull(err);
        assert.isNull(balance);
        done();
      });
    });
  });

  describe('#monitorAccount', function() {
    it('should emit "funded" event on funded account', function(done) {
      var fundEmitted = null;
      var satoshiAmount = 10 * gait.EPSILON;

      gait.once('error', function () {
        assert.fail('shouldn\'t have errored');
      });
      gait.once('funded', function (account, balance) {
        fundEmitted = {account: account, balance: balance};
      });

      gait.newAddress('funding', function (err, addr) {
        gait._sendFrom('stash', addr, satoshiAmount, 0, function (err) {
          if (err) return done(err);
          gait.monitorAccount('funding', function (err, balance, txIds) {
            if (err) return done(err);
            try {
              assert.isNull(err);
              assert.equal(balance, satoshiAmount);
              assert.equal(fundEmitted.balance, satoshiAmount);
              assert.equal(fundEmitted.account, 'funding');
              assert.ok(txIds.length);
            } catch (e) { return done(e); }
            done();              
          });
        });
      });
    });
  });

});
