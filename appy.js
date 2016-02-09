/* jshint node:true */

var express = require('express');
var _ = require('lodash');
var passport = require('passport');
var fs = require('fs');
var async = require('async');
var mongo = require('mongodb');
var ConnectMongo = require('connect-mongo')(express);
var flash = require('connect-flash');
var dirname = require('path').dirname;
var lessMiddleware = require('less-middleware');
var passwordHash = require('password-hash');
var clone = require('clone');
var bless = require('bless');
var path = require('path');
var options, globalOptions;
var db;
var app, baseApp;

var log = function(action, info) {
  // Default is to do nothing, see options.log
};

var authStrategies = {
  twitter: function(authOptions)
  {
    var TwitterStrategy = require('passport-twitter').Strategy;
    passport.use(new TwitterStrategy(
      authOptions,
      function(token, tokenSecret, profile, done) {
        // We now have a unique id, username and full name
        // (display name) for the user courtesy of Twitter.

        var user = clone(profile);

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
        // Make sure we're not vulnerable to an exploit trying passwords
        // that will match all users for whom either username or email
        // happens to be blank
        if (!username.length) {
          log('blank username', { username: username });
          return done(null, false, { message: 'Invalid username or password' });
        }
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
        var match = emailMatch(username);
        var user = _.find(options.users, function(user) {
          if (user.username === username) {
            return true;
          }
          // World's tiniest mongodb match evaluator: if it's an object
          // assume it's a regex and call test on it. If it's not, assume
          // it's a string and look for equality
          if (typeof(match) === 'object') {
            return match.test(user.email);
          }
          return match === user.email;
        });
        if (user) {
          if (user.password === password) {
            // Never modify the original from the array
            user = _.cloneDeep(user);
            // Don't keep this around where it might wind up
            // in a session or worse
            delete user.password;
            // For the convenience of mongodb (it's unique)
            user._id = username;
            log('login', { username: username, _id: user._id });
            return done(null, user);
          } else {
            log('incorrect password', { username: username });
            return done(null, false, { message: 'Invalid username or password' });
          }
        }
        var collection = options.collection || 'users';
        if (!module.exports[collection]) {
          log('invalid users collection', { username: username });
          return done(null, false, { message: 'Invalid username or password' });
        }
        var users = module.exports[collection];
        var criteria = { $or: [ { username: username }, { email: emailMatch(username) } ] };
        if (options.extraLoginCriteria) {
          criteria = { $and: [ criteria, options.extraLoginCriteria ] };
        }
        users.findOne(criteria, function(err, user) {
          if (err) {
            return done(err);
          }
          if (!user) {
            log('no such user', { username: username });
            return done(null, false, { message: 'Invalid username or password' });
          }
          // Allow an alternate password verification function
          var verify = options.verify || function(password, hash) {
            return passwordHash.verify(password, hash);
          };
          var result = verify(password, user.password);
          if (result) {
            // Don't keep this around where it might wind up in a session somehow,
            // even though it's hashed that is still dangerous
            delete user.password;

            // Flag indicating this user came from mongodb. We use this to
            // determine we should refresh them from the database via the
            // serialization middleware, to ensure we have an up to date idea
            // of their profile and privileges
            user._mongodb = true;
            log('login', { username: username, _id: user._id });
            return done(null, user);
          } else {
            log('incorrect password', { username: username });
            return done(null, false, { message: 'Invalid username or password' });
          }
        });

        function emailMatch(email) {
          if (options.emailMatch) {
            // Call emailMatch option which will likely return a regex
            return options.emailMatch(email);
          }
          // Just do a string match
          return email;
        }
      }
    ));

    passport.serializeUser(function(user, done) {
      if (user._mongodb) {
        // MongoDB user - store enough info to look them up on each request.
        // That buys us the ability to lock out someone who has
        // lost their account, display someone's edited name, etc.
        return done(null, JSON.stringify({ _id: user._id, _mongodb: true }));
      } else {
        // Twitter or a hardcoded local user
        return done(null, JSON.stringify(user));
      }
    });

    passport.deserializeUser(function(json, done) {
      var user = JSON.parse(json);
      if (!user)
      {
        // Passing false as second argument clears their
        // session so they can run around as a logged out person
        // and try again; much more useful than an inscrutable
        // error message with line numbers, which is what
        // passport does if you report an error
        // https://github.com/jaredhanson/passport/issues/6
        return done(null, false);
      }
      if (user._mongodb) {
        return async.series({
          findUser: function(callback) {
            var collection = options.collection || 'users';
            var users = module.exports[collection];
            return users.findOne({ _id: user._id }, function(err, mongoUser) {
              if (err) {
                return callback(err);
              }
              if (!mongoUser) {
                return done(null, false);
              }
              user = mongoUser;
              user._mongodb = true;
              return callback(null);
            });
          },
          afterDeserializeUser: function(callback) {
            // Never any reason to expose this
            delete user.password;
            if (!options.afterDeserializeUser) {
              return callback(null);
            }
            return options.afterDeserializeUser(user, callback);
          }
        }, function(err) {
          return done(null, err ? false : user);
        });
      } else {
        return done(null, user);
      }
    });

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
          '<form action="' + (globalOptions.prefix || '') + '/login" method="post">' +
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
      // Let the login template also access the query string parameters
      // for a little extra flexibility in showing messages to the user
      var data = {
        message: message,
        query: req.query
      };

      if(options.passReq){
        res.send(options.template(data, req));
      } else {
        res.send(options.template(data));
      }
    });
    app.post('/login',
      passport.authenticate('local',
        { failureRedirect: '/login', failureFlash: true }),
      function(req, res) {
        if (options.redirect) {
          // Send the response back to app.js to check permissions.
          // New version: takes req and callback
          if (options.redirect.length === 2) {
            return options.redirect(req, function(url) {
              return res.redirect(url);
            });
          }
          // bc version: no callback or req
          return res.redirect(options.redirect(req.user));
        } else {
          // If for some reason the Apostrophe.js check doesn't work
          // then home seems a sensible default.
          res.redirect('/');
        }
      }
    );
  }
};

module.exports.bootstrap = function(optionsArg)
{
  globalOptions = options = optionsArg;

  if (options.log) {
    log = options.log;
  }

  if (!options.rootDir) {
    // Convert foo/node_modules/appy back to foo,
    // so we can find things like foo/data/port automatically
    options.rootDir = dirname(dirname(__dirname));
  }

  // Allow passport to be passed in to ensure the same instance
  // is used throughout a project that adds other authorization
  // strategies
  if (options.passport) {
    passport = options.passport;
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
  // Open the database connection. Always use MongoClient with its
  // sensible defaults. Build a URI if we need to so we can call it
  // in a consistent way

  return async.series({
    connect: function(callback) {
      var uri = 'mongodb://';
      if (options.db.uri) {
        uri = options.db.uri;
      } else {
        if (options.db.user) {
          uri += options.db.user + ':' + options.db.password + '@';
        }
        if (!options.db.host) {
          options.db.host = 'localhost';
        }
        if (!options.db.port) {
          options.db.port = 27017;
        }
        uri += options.db.host + ':' + options.db.port + '/' + options.db.name;
      }
      return mongo.MongoClient.connect(uri, function (err, dbArg) {
        db = dbArg;
        return callback(err);
      });
    },
    collections: function(callback) {
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
  }, callback);
}

function appBootstrap(callback) {

  if (options.prefix) {
    var original = express.response.redirect;
    express.response.redirect = function(status, url) {
      if (arguments.length === 1) {
        url = status;
        status = 302;
      }
      if (!url.match(/^[a-zA-Z]+:/))
      {
        url = options.prefix + url;
      }
      return original.call(this, status, url);
    };
  }

  app = module.exports.app = express();
  if (options.prefix) {
    baseApp = express();
    baseApp.use(options.prefix, app);
  }

  // Get the compress middleware in there right away to avoid conflicts
  // and maximize its use. It's awesome, but you can disable it
  // if you feel you really must
  if (options.compress !== false) {
    app.use(express.compress());
  }

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
      app.use(lessMiddleware(options.static, {
        postprocess: {
          css: function(css) {
            if (!options.prefix) {
              return css;
            }
            css = prefixCssUrls(css);
            return css;
          }
        },

        // If requested, use BLESS to split CSS into multiple files
        // for <=IE9, but only if there's enough to make it necessary
        storeCss: function(pathname, css, next) {
          if (!globalOptions.bless) {
            fs.writeFileSync(pathname, css);
            return next();
          }
          var output = path.dirname(pathname);
          new (bless.Parser)({
            output: output,
            options: {}
          }).parse(css, function (err, files) {
            if (files.length === 1) {
              // No splitting needed for <= IE9
              fs.writeFileSync(pathname, css);
              return next();
            }
            var master = '';
            var n = 1;
            _.each(files, function(file) {
              var filePath = addN(pathname);
              var basename = path.basename(pathname);
              var webPath = addN(basename);
              fs.writeFileSync(filePath, file.content);
              master += '@import url("' + webPath + '");\n';
              n++;
            });
            function addN(filename) {
              return filename.replace(/\.css$/, '-' + n + '.css');
            }
            fs.writeFileSync(pathname, master);
            return next();
          });
        }

        //   fs.mkdirp(path.dirname(pathname), 511 /* 0777 */, function(err) {
        //     if (err) return next(err);

        //     fs.writeFile(pathname, css, 'utf8', next);
        //   });
        // }

      },
      {
        // parser options
      },
      {
        compress: true,
      }));
    }
    app.use(express.static(options.static));
  }

  app.use(express.bodyParser());
  app.use(express.cookieParser());

  // Express sessions let us remember the mood the user wanted while they are off logging in on twitter.com

  // The mongo session store allows our sessions to persist between restarts of the app

  // We changed the collection name from the old "sessions" so that connect-mongo doesn't
  // try to parse sessions created by connect-mongodb, which won't work

  // It was a bad choice to use "options.sessions" for the options to the store, for bc
  // we accept it but now we encourage "sessionStore" and "sessionCore" which helps
  // a little with that sloppy mess

  var storeOptions = clone(options.sessionStore || options.sessions || {});
  storeOptions.db = db;

  var sessions;

  return async.series({
    sessionCollection: function(callback) {
      // Get access to the collection that connect-mongo will use so we can
      // upgrade old sessions first.
      return db.collection(storeOptions.collection || 'sessions', options, function(err, collection) {
        if (err) {
          return callback(err);
        }
        sessions = collection;
        return callback(null);
      });
    },
    sessionUpgrade: function(callback) {
      // upgrade connect-mongodb sessions to connect-mongo by giving them an
      // expires property, without which connect-mongo won't look at them.
      // Set them to the connect-mongo default of 2 weeks.
      var today = new Date();
      var twoWeeks = 1000 * 60 * 60 * 24 * 14;
      var expires = new Date(today.getTime() + twoWeeks);
      return sessions.update(
        {
          expires: { $exists: 0 }
        },
        {
          $set: { expires: expires }
        },
        {
          multi: true
        }, callback
      );
    }
  }, function(err) {
    if (err) {
      return callback(err);
    }
    mongoStore = new ConnectMongo(storeOptions);
    var sessionOptions = {
      secret: options.sessionSecret,
      store: mongoStore
    };
    _.assign(sessionOptions, options.sessionCore || {});
    app.use(express.session(sessionOptions));
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

      app.get('/logout', function(req, res)
      {
        req.logOut();
        res.redirect('/');
      });
    }

    return callback(null);
  });

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

module.exports.listen = function(address, port /* or just port, or nothing */) {
  if (arguments.length === 1) {
    port = address;
    address = undefined;
  }
  address = address || options.address;
  port = port || options.port;

  // Heroku
  if (process.env.ADDRESS) {
    address = process.env.ADDRESS;
  } else {
    if (address === undefined || address === '') {
      try {
        // Stagecoach option
        address = fs.readFileSync(options.rootDir + '/data/address', 'UTF-8').replace(/\s+$/, '');
      } catch (err) {
        address = '0.0.0.0';
        console.log("I see no data/address file, defaulting to address " + address);
      }
    }
  }
  if (process.env.PORT) {
    port = process.env.PORT;
  } else {
    if (!port) {
      try {
        // Stagecoach option
        port = fs.readFileSync(options.rootDir + '/data/port', 'UTF-8').replace(/\s+$/, '');
      } catch (err) {
        port = 3000;
        console.log("I see no data/port file, defaulting to port " + port);
      }
    }
  }
  if (port.toString().match(/^\d+$/)) {
    console.log("Listening on " + address + ":" + port);
    (baseApp || app).listen(port, address);
  } else {
    console.log("Listening at " + port);
    (baseApp || app).listen(port);
  }
};


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

function prefixCssUrls(css) {
  css = css.replace(/url\(([^'"].*?)\)/g, function(s, url) {
    if (url.match(/^\//)) {
      url = options.prefix + url;
    }
    return 'url(' + url + ')';
  });
  css = css.replace(/url\(\"(.+?)\"\)/g, function(s, url) {
    if (url.match(/^\//)) {
      url = options.prefix + url;
    }
    return 'url("' + url + '")';
  });
  css = css.replace(/url\(\'(.+?)\'\)/g, function(s, url) {
    if (url.match(/^\//)) {
      url = options.prefix + url;
    }
    return 'url(\'' + url + '\')';
  });
  return css;
}

// In case you need to compile CSS in a compatible way
// elsewhere in your app
module.exports.prefixCssUrls = prefixCssUrls;

