var Bitcoin = require('bitcoinjs-lib');
var ab = require('./autobahn');
var http = require('http');
var when = require('when');
var async = require('async');

var GAConnection = function(ws_url, token_url, additional_accounts) {
	this.calls = [];
	this.everConnected = false;
	this.disconnected = false;
	this.retries = 60;
	this.connect(ws_url, token_url);
  this.DEFAULT_ACCOUNTS = [[1, 'pool'],
                           [2, 'deposit']];
  this.accounts = {'funding': null};
  var all_accounts = this.DEFAULT_ACCOUNTS.concat(additional_accounts || []);
  for (var i = 0; i < all_accounts.length; i++) {
    var ac = all_accounts[i];
    this.accounts[ac[1]] = ac[0];
  }
};

GAConnection.prototype.connect = function(ws_url, token_url) {
	var self = this;
	ab.connect(ws_url, function(session) {
		self.everConnected = true;
		http.get(token_url, function(res) {
			res.on('data', function(token) {
	      session.authreq(token.toString()).then(function(challenge) {
	        var signature = session.authsign(challenge, token.toString());
	        session.auth(signature).then(function(permissions) {
	        	self.session = session;
	          self.on_wamp_auth(session);
	        });
	      });
	    });
		});
	}, function(code, reason) {
    if (self.retries && !self.everConnected) {  // autobahnjs doesn't reconnect automatically if it never managed to connect
    	console.error('Not connected: ' + reason + '. Retrying ' + self.retries + ' more times.')
      self.retries -= 1;
      setTimeout(function() { self.connect.apply(self) }, 5000);
      return;
    }
    if (reason && reason.indexOf('WS-4000') != -1) {
      console.error('Disconnected: double login error!')
    } else {
    	console.error('Connect error: ' + reason)
    }
    session = null;
  }, {maxRetries: 60});
};

GAConnection.prototype.call = function() {
  var d = when.defer();
  if (this.session) {
    return this.session.call.apply(this.session, arguments);
  } else {
    if (this.disconnected) {
      this.disconnected = false;
      this.connect();
    }
    this.calls.push([arguments, d]);
  }
  return d.promise;
};

GAConnection.prototype.loginCall = function() {
  var args = arguments,
      self = this;
  return this.login().then(function() {
    return self.call.apply(self, args);
  });
}

GAConnection.prototype.on_wamp_auth = function(session) {
  /*session.subscribe('http://greenaddressit.com/tx_notify', function(topic, event) {});
  session.subscribe('http://greenaddressit.com/block_count', function(topic, event) {});*/
  var d1, self = this;
  if (this.hdwallet && this.logged_in) {
    this.logged_in = false;
    d1 = this.login();
  } else {
    d1 = when(true);
  }
  d1.catch(function(err) { 
    if (err.uri == 'http://greenaddressit.com/error#doublelogin') {
      console.error('Double login error!')
    } else {
      console.error('Login error: ' + err.desc);
    }
  });
  d1.then(function() {
    // missed calls queue
    while (self.calls.length) {
      var item = self.calls.shift();
      item[1].resolve(self.call.apply(self, item[0]));
    }
  }, function(err) {
    // missed calls queue - reject them as well
    while (self.calls.length) {
      var item = self.calls.shift();
      item[1].reject(err);
    }
  });
};

GAConnection.prototype._makeAccounts = function() {
  var self = this, d = when.defer();
  accounts = [];
  for (var k in this.accounts)
    if (this.accounts[k] !== null) accounts.push([this.accounts[k], k]);
  async.map(accounts,
    function(ac, cb) {
      var subwallet = self.hdwallet.derive(3);
      subwallet = subwallet.derivePrivate(ac[0]);
      var pk = subwallet.pub.toHex();
      var cc = Bitcoin.convert.bytesToHex(subwallet.chaincode);
      self.call('http://greenaddressit.com/txs/create_subaccount', ac[0], ac[1], pk, cc).then(function() {
        cb();
      }, function(err) {
        if (err.uri == "http://greenaddressit.com/error#alreadyexists") {
          cb();
        } else {
          cb(err);
        }
      });
    },
    function(err, results) {
      if (err) d.reject(err);
      else d.resolve();
    }
  );
  return d.promise;
}

GAConnection.prototype.login = function() {
  var d = when.defer();
  if (this.logged_in) {
    d.resolve(this.logged_in);
  } else {
  	var self = this;
    this.call('http://greenaddressit.com/login/get_challenge',
        this.hdwallet.getAddress().toString()).then(function(challenge) {
      var challenge_bytes = new Bitcoin.BigInteger(challenge).toByteArrayUnsigned();

      // generate random path to derive key from - avoids signing using the same key twice
      var max64int_hex = '';
      while (max64int_hex.length < 16) max64int_hex += 'F';
      var TWOPOWER64 = new Bitcoin.BigInteger(max64int_hex, 16).add(Bitcoin.BigInteger.ONE);
      var random_path_hex = Bitcoin.ecdsa.getBigRandom(TWOPOWER64).toString(16);
      while (random_path_hex.length < 16) random_path_hex = '0' + random_path_hex;

      // subpath_for_login:
      var key = self.hdwallet;
	    var path_bytes = Bitcoin.convert.hexToBytes(random_path_hex);
	    for (var i = 0; i < 4; i++) {
        key = key.derive(+Bitcoin.BigInteger.fromByteArrayUnsigned(path_bytes.slice(0, 2)));
        path_bytes = path_bytes.slice(2);
	    }

	    var signature = key.priv.sign(challenge_bytes);
      signature = Bitcoin.ecdsa.parseSig(signature);
      var logout = true;
      d.resolve(self.call('http://greenaddressit.com/login/authenticate',
          [signature.r.toString(), signature.s.toString()], true, random_path_hex).then(function(data) {
        self.logged_in = data;
        return self._makeAccounts().then(function() {
          return data;
        });
      }));
    });
  }
  return d.promise;
};

module.exports = GAConnection;