var Bitcoin = require('bitcoinjs-lib');
var ab = require('./autobahn');
var http = require('http');
var when = require('when');

var GAConnection = function() {
	this.calls = [];
	this.everConnected = false;
	this.disconnected = false;
	this.retries = 60;
	this.connect();
};

GAConnection.prototype.connect = function() {
	var that = this;
	ab.connect('ws://localhost:9335/ws/inv', function(session) {
		that.everConnected = true;
		http.get('http://localhost:9908/token/', function(res) {
			res.on('data', function(token) {
	      session.authreq(token.toString()).then(function(challenge) {
	        var signature = session.authsign(challenge, token.toString());
	        session.auth(signature).then(function(permissions) {
	        	that.session = session;
	          that.on_wamp_auth(session);
	        });
	      });
	    });
		});
	}, function(code, reason) {
    if (that.retries && !that.everConnected) {  // autobahnjs doesn't reconnect automatically if it never managed to connect
    	console.error('Not connected: ' + reason + '. Retrying ' + that.retries + ' more times.')
      that.retries -= 1;
      setTimeout(function() { that.connect.apply(that) }, 5000);
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

GAConnection.prototype.on_wamp_auth = function(session) {
  /*session.subscribe('http://greenaddressit.com/tx_notify', function(topic, event) {});
  session.subscribe('http://greenaddressit.com/block_count', function(topic, event) {});*/
  var d1, that = this;
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
    while (that.calls.length) {
      var item = that.calls.shift();
      item[1].resolve(that.call.apply(that, item[0]));
    }
  }, function(err) {
    // missed calls queue - reject them as well
    while (that.calls.length) {
      var item = that.calls.shift();
      item[1].reject(err);
    }
  });
};

GAConnection.prototype.login = function(hdwallet) {
  var d = when.defer();
  if (this.logged_in) {
    d.resolve(this.logged_in);
  } else {
  	var that = this;
  	if (hdwallet) {
  		this.hdwallet = hdwallet;
  	}
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
      var key = that.hdwallet;
	    var path_bytes = Bitcoin.convert.hexToBytes(random_path_hex);
	    for (var i = 0; i < 4; i++) {
        key = key.derive(+Bitcoin.BigInteger.fromByteArrayUnsigned(path_bytes.slice(0, 2)));
        path_bytes = path_bytes.slice(2);
	    }

	    var signature = key.priv.sign(challenge_bytes);
      signature = Bitcoin.ecdsa.parseSig(signature);
      var logout = true;
      d.resolve(that.call('http://greenaddressit.com/login/authenticate',
          [signature.r.toString(), signature.s.toString()], true, random_path_hex).then(function(data) {
        that.logged_in = data;
        return data;
      }));
    });
  }
  return d.promise;
};

module.exports = GAConnection;