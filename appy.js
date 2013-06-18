var express = require('express');
var _ = require('underscore');
var passport = require('passport');
var fs = require('fs');
var async = require('async');
var mongo = require('mongodb');
var connectMongoDb = require('connect-mongodb');
var flash = require('connect-flash');
var url = require('url');
var dirname = require('path').dirname;
var lessMiddleware = require('less-middleware');
var passwordHash = require('password-hash');

var options;
var db;
var app;
var insecure = { login: true, logout: true };

var authStrategies = {
  twitter: function(authOptions)
  {
    var TwitterStrategy = require('passport-twitter').Strategy;
    passport.use(new TwitterStrategy(
      authOptions,
      function(token, tokenSecret, profile, done) {
        // We now have a unique id, username and full name
        // (display name) for the user courtesy of Twitter.

        var user = _.clone(profile);

        // For the convenience of mongodb
        user._id = user.id;

        // Also copy the token and tokenSecret so that
        // we can send tweets on the user's behalf at
        // any time via ntwitter
        user.token = token;
        user.tokenSecret = tokenSecret;

        // If you want to capture information about the user
        // permanently in the database, this is a great callback
        // to do it with
        if (options.beforeSignin) {
          options.beforeSignin(user, function(err) {
            if (err) {
              return done(err);
            }
            done(null, user);
          });
        } else {
          done(null, user);
        }
      }
    ));

    // Redirect the user to Twitter for authentication.  When complete, Twitter
    // will redirect the user back to the application at
    // /auth/twitter/callback
    app.get('/login', passport.authenticate('twitter'));

    // Twitter will redirect the user to this URL after approval.  Finish the
    // authentication process by attempting to obtain an access token.  If
    // access was granted, the user will be logged in.  Otherwise,
    // authentication has failed.
    app.get('/twitter-auth',
      passport.authenticate('twitter', { successRedirect: '/twitter-auth-after-login',
                                         failureRedirect: '/' }));
    app.get('/twitter-auth-after-login', function(req, res) {
      if (req.session.afterLogin) {
        return res.redirect(req.session.afterLogin);
      } else {
        return res.redirect('/');
      }
    });
  },
  local: function(options)
  {
    // First check the hardcoded users. Then check mongodb users. You can specify
    // an alternate collection name. The collection must have a username property
    // and a password property, which should have been set by the password-hash
    // npm module. Populating that table with users is up to you, see the
    // apostrophe-people module for one example

    var LocalStrategy = require('passport-local').Strategy;
    passport.use(new LocalStrategy(
      function(username, password, callback) {
        function done(err, user, args) {
          if (err || (!user)) {
            return callback(err, user, args);
          }
          if (options.beforeSignin) {
            return options.beforeSignin(user, function(err) {
              if (err) {
                // A backwards-compatible way to allow beforeSignin to pass
                // a message to the login dialog rather than triggering as a
                // straight 500 error
                if (err.message) {
                  return callback(null, false, err);
                } else {
                  return callback(err);
                }
              }
              return callback(null, user, args);
            });
          }
          return callback(null, user, args);
        }
        var user = _.find(options.users, function(user) {
          return (user.username === username);
        });
        if (user) {
          if (user.password === password) {
            // For the convenience of mongodb (it's unique)
            user._id = username;
            return done(null, user);
          } else {
            return done(null, false, { message: 'Invalid username or password' });
          }
        }
        var collection = options.collection || 'users';
        if (!module.exports[collection]) {
          return done(null, false, { message: 'Invalid username or password' });
        }
        var users = module.exports[collection];
        users.findOne({ username: username }, function(err, user) {
          if (err) {
            return done(err);
          }
          var result = passwordHash.verify(password, user.password);
          if (result) {
            // Don't keep this around where it might wind up in a session somehow,
            // even though it's hashed that is still dangerous
            delete user.password;
            return done(null, user);
          } else {
            return done(null, false, { message: 'Invalid username or password' });
          }
        });
      }
    ));
    app.get('/login', function(req, res) {
      var message = req.flash('error');
      if (Array.isArray(message) && message.length) {
        // Why is it an array? Well, whatever
        message = message.join(' ');
      } else {
        message = null;
      }
      if (!options.template) {
        options.template =
          '<style>' +
          '.appy-login' +
          '{' +
          '  width: 300px;' +
          '  border: 2px solid #ccc;' +
          '  border-radius: 6px;' +
          '  padding: 10px;' +
          '  margin: auto;' +
          '  margin-top: 100px;' +
          '}' +
          '.appy-login label' +
          '{' +
          '  float: left;' +
          '  width: 150px;' +
          '}' +
          '.appy-login div' +
          '{' +
          '  margin-bottom: 20px;' +
          '}' +
          '</style>' +
          '<div class="appy-login">' +
          '<% if (message) { %>' +
          '<h3><%= message %></h3>' +
          '<% } %>' +
          '<form action="/login" method="post">' +
            '<div>' +
            '<label>Username</label>' +
            '<input type="text" name="username" /><br/>' +
            '</div>' +
            '<div>' +
            '<label>Password</label>' +
            '<input type="password" name="password"/>' +
            '</div>' +
            '<div class="appy-submit">' +
            '<input type="submit" value="Log In"/>' +
            '</div>' +
          '</form>' +
          '</div>';
      }
      if (typeof(options.template) !== 'function') {
        options.template = _.template(options.template);
      }
      res.send(options.template({ message: message }));
    });
    app.post('/login',
      passport.authenticate('local',
        { failureRedirect: '/login', failureFlash: true }),
      function(req, res) {
        res.redirect('/');
      }
    );
  }
};

module.exports.bootstrap = function(optionsArg)
{
  options = optionsArg;
  if (!options.rootDir) {
    // Convert foo/node_modules/appy back to foo,
    // so we can find things like foo/data/port automatically
    options.rootDir = dirname(dirname(__dirname));
  }

  async.series([dbBootstrap, appBootstrap], function(err) {
    if (err) {
      console.log(err);
      process.exit(1);
    }
    options.ready(app, db);
  });
};

function dbBootstrap(callback) {
  // Open the database connection

  if (options.db.uri) {
    // Borrowed this logic from mongoose https://github.com/LearnBoost/mongoose/blob/master/lib/connection.js#L143
    var uri = url.parse(options.db.uri);
    options.db.host = uri.hostname;
    if (parseInt(uri.port, 10)) {
      options.db.port = parseInt(uri.port, 10);
    } else {
      uri.port = 27017;
    }
    options.db.name = uri.pathname && uri.pathname.replace(/\//g, '');
    if (uri.auth) {
      var auth = uri.auth.split(':');
      options.db.user = auth[0];
      options.db.password = auth[1];
    }
  }
  if (!options.db.host) {
    options.db.host = 'localhost';
  }
  if (!options.db.port) {
    options.db.port = 27017;
  }

  db = module.exports.db = new mongo.Db(
    options.db.name,
    new mongo.Server(options.db.host, options.db.port, {}),
    // Sensible default of safe: true
    // (soon to be the driver's default)
    { safe: true });

  db.open(function(err) {
    if (err)
    {
      callback(err);
      return;
    }
    if (options.db.user) {
      db.authenticate(options.db.user, options.db.password, authenticated);
    } else {
      authenticated(null);
    }
  });

  function authenticated(err) {
    if (err) {
      callback(err);
      return;
    }

    // Automatically configure a collection for users if the local strategy
    // is in use

    var collections = options.db.collections || [];
    if (options.auth && (options.auth.strategy === 'local')) {
      var authCollection = options.auth.options.collection || 'users';
      if (!_.contains(collections, authCollection)) {
        collections.push(authCollection);
      }
    }

    async.map(collections, function(info, next) {
      var name;
      var options;
      if (typeof(info) !== 'string') {
        name = info.name;
        options = info;
        delete options.name;
      }
      else
      {
        name = info;
        options = {};
      }
      db.collection(name, options, function(err, collection) {
        if (err) {
          console.log('no ' + name + ' collection available, mongodb offline?');
          console.log(err);
          process.exit(1);
        }
        if (options.index) {
          options.indexes = [ options.index ];
        }
        if (options.indexes) {
          async.map(options.indexes, function(index, next) {
            var fields = index.fields;
            // The remaining properties are options
            delete index.fields;
            collection.ensureIndex(fields, index, next);
          }, function(err) {
            if (err) {
              console.log('Unable to create index');
              console.log(err);
              process.exit(1);
            }
            afterIndexes();
          });
        }
        else
        {
          afterIndexes();
        }
        function afterIndexes() {
          module.exports[name] = collection;
          next();
        }
      });
    }, callback);
  }
}

function appBootstrap(callback) {
  app = module.exports.app = express();

  // Serialize users directly in the session. So far this
  // works for the passport strategies I've used and
  // avoids database hits

  passport.serializeUser(function(user, done) {
    done(null, JSON.stringify(user));
  });

  passport.deserializeUser(function(json, done) {
    var user = JSON.parse(json);
    if (user)
    {
      done(null, user);
    }
    else
    {
      done(new Error("Bad JSON string in session"), null);
    }
  });

  if (options.host) {
    app.use(canonicalizeHost);
  }

  // By default we supply LESS middleware
  if (options.less === undefined) {
    options.less = true;
  }

  if (options.static)
  {
    if (options.less) {
      app.use(lessMiddleware({
        src: options.static,
        compress: true
      }));
    }
    app.use(express.static(options.static));
  }

  app.use(express.bodyParser());
  app.use(express.cookieParser());

  // Express sessions let us remember the mood the user wanted while they are off logging in on twitter.com
  // The mongo session store allows our sessions to persist between restarts of the app
  var mongoStore = new connectMongoDb({ db: db });

  app.use(express.session({ secret: options.sessionSecret, store: mongoStore }));
  // We must install passport's middleware before we can set routes that depend on it
  app.use(passport.initialize());
  // Passport sessions remember that the user is logged in
  app.use(passport.session());

  // Always make the authenticated user object available
  // to templates
  app.use(function(req, res, next) {
    res.locals.user = req.user ? req.user : null;
    next();
  });

  // Inject 'partial' into the view engine so that we can have real
  // partials with a separate namespace and the ability to extend
  // their own parent template, etc. Express doesn't believe in this, 
  // but we do.
  //
  // Use a clever hack to warn the developer it's not going to work
  // if they have somehow found a template language that is 
  // truly asynchronous.

  app.locals.partial = function(name, data) {
    var result = '___***ASYNCHRONOUS';
    if (!data) {
      data = {};
    }
    if (!data._locals) {
      data._locals = {};
    }
    if (!data._locals.partial) {
      data._locals.partial = app.locals.partial;
    }
    app.render(name, data, function(err, resultArg) {
      result = resultArg;
    });
    if (result === '___***ASYNCHRONOUS') {
      throw "'partial' cannot be used with an asynchronous template engine";
    }
    return result;
  };

  // Always define 'error' so we can 'if' on it painlessly
  // in Jade. This is particularly awkward otherwise
  app.locals.error = null;

  // Always make flash attributes available
  app.use(flash());

  // viewEngine can be a custom function to set up the view engine
  // yourself (useful for Nunjucks and other view engines with a
  // nonstandard setup procedure with Express)
  if (typeof(options.viewEngine) === 'function') {
    options.viewEngine(app);
  } else {
    app.set('view engine', options.viewEngine ? options.viewEngine : 'jade');
  }

  // Before we set up any routes we need to set up our security middleware

  if (!options.unlocked)
  {
    options.unlocked = [];
  }
  _.each(['/login', '/logout', '/twitter-auth'], function(url) {
    if (!_.include(options.unlocked, url))
    {
      options.unlocked.push(url);
    }
  });

  if (options.locked === true) {
    // Secure everything except prefixes on the unlocked list
    // (the middleware checks for those)
    app.use(securityMiddleware);
  } else if (options.locked) {
    // Secure only things matching the given prefixes, minus things
    // matching the insecure list
    if (typeof(options.locked) === 'string')
    {
      options.locked = [options.locked];
    }
    _.each(options.locked, function(prefix) {
      app.use(prefix, securityMiddleware);
    });
  } else {
    // No security by default (but logins work and you can check req.user yourself)
  }

  // Add additional global middleware. Needs to happen before we add any routes,
  // so we do it before the security strategies, which often add routes
  if (options.middleware) {
    _.each(options.middleware, function(middleware) {
      app.use(middleware);
    });
  }

  if (options.auth)
  {
    // One can pass a custom strategy object or the name
    // of a built-in strategy
    var strategy;
    if (typeof(options.auth.strategy) === 'string') {
      strategy = authStrategies[options.auth.strategy];
    } else {
      strategy = options.auth.strategy;
    }
    options.auth.options.app = app;
    // We made this option top level, but
    // custom auth strategies need to be able to see it
    options.auth.options.beforeSignin = options.beforeSignin;
    strategy(options.auth.options);
  }

  app.get('/logout', function(req, res)
  {
    req.logOut();
    res.redirect('/');
  });

  callback(null);

  // Canonicalization is good for SEO and prevents user confusion,
  // Twitter auth problems in dev, etc.
  function canonicalizeHost(req, res, next)
  {
    if (req.headers.host !== options.host)
    {
      res.redirect(301, 'http://' + options.host + req.url);
    }
    else
    {
      next();
    }
  }
}


module.exports.listen = function(host) {
  // Default port for dev
  var port = 3000;

  var setHost = '0.0.0.0';

  if(host !==undefined || host !==''){
      setHost = host;
  }


  // Heroku
  if (process.env.PORT) {
    port = process.env.PORT;
  } else {
    try {
      // Stagecoach option
      port = fs.readFileSync(options.rootDir + '/data/port', 'UTF-8').replace(/\s+$/, '');
    } catch (err) {
      console.log("I see no data/port file, defaulting to port " + port);
    }

    if(host === undefined || host===''){
        try {
          // Stagecoach option
          setHost = fs.readFileSync(options.rootDir + '/data/host', 'UTF-8').replace(/\s+$/, '');
        } catch (err) {
          console.log("I see no data/host file, defaulting to host" + setHost);
        }
    }
  }

  console.log("Listening on "+setHost+":"+ port);
  app.listen(port,setHost);
}


function securityMiddleware(req, res, next) {
  var i;
  // The full URL we really care about is in req.originalUrl.
  // req.url has any prefix used to set up this middleware
  // already lopped off, which is clever and useful, but
  // not in this situation
  for (i = 0; (i < options.unlocked.length); i++) {
    if (prefixMatch(options.unlocked[i], req.originalUrl)) {
      next();
      return;
    }
  }

  if (!req.user) {
    req.session.afterLogin = req.originalUrl;
    res.redirect(302, '/login');
    return;
  } else {
    next();
  }
}

// Match URL prefixes the same way Connect middleware does
function prefixMatch(prefix, url)
{
  var start = url.substr(0, prefix.length);
  if (prefix === start) {
    var c = url[prefix.length];
    if (c && ('/' != c) && ('.' != c) && ('?' != c)) {
      return false;
    }
    return true;
  }
  return false;
}

