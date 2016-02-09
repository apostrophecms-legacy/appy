# Appy

<a href="http://apostrophenow.org/"><img src="https://raw.github.com/punkave/appy/master/logos/logo-box-madefor.png" align="right" /></a>

Bootstraps a typical Express 3.0 app with even less fuss than usual. Makes a bunch of bold assumptions that are spot on for us and allow us to get moving swiftly. If they work for you too... awesome! If not, no worries. Appy isn't doing anything you can't do yourself in an hour or two.

Appy creates an app that:

* Supports local users in a MongoDB collection and/or a hardcoded list
* Alternatively, supports Twitter authentication
* Also supports custom auth strategy functions
* Has /login and /logout URLs for the above
* Provides a post-authentication callback
* Provides a MongoDB database for storage and for sessions, with sensible defaults
* Provides ready-to-rock MongoDB collections
* Eases configuration of MongoDB indexes
* Redirects traffic to a canonical hostname
* Offers a simple way to lock any part of the app to require login
* Has the Express compress, bodyParser, session and cookie middleware in place
* Uses the jade template engine by default, but you can configure others
* If `address` and `port` are not configured as options or passed to `listen`, listens on port 3000 on all interfaces. Also supports PORT and HOST environment variables, or `data/port` and `data/address` files (ready for use with Heroku or Stagecoach). Explicit settings always win.
* Adds support for robust partials to whatever template language you choose
* Serves static files from a specified folder (use the `static` option)
* Performs automatic LESS stylesheet compilation with `less-middleware` if a `.css` file is requested and the corresponding `.less` file exists in the static folder
* Provides a way to add more custom middleware if you wish, before any routes are added.

## Using Appy

You must pass a callback function called `ready` to the appy.boostrap method. This callback receives the Express app and the db for convenience, however you can also access them as properties of the appy object.

Your `ready` callback must then invoke `appy.listen` after setting up Express routes and anything else you'd like to do before you listen for connections.

Here's a simple example (see also `sample.js`):

    var appy = require(__dirname + '/appy.js');

    appy.bootstrap({
      // Hardcode some users. Will also look for users in the users collection by default
      auth: {

        strategy: 'local',

        options: {
          users: {
            admin: {
              username: 'admin',
              password: 'demo'
            }
          },

          emailMatch: function(email) {

            // you can build and return a regex here if you want email
            // addresses to be matched case insensitively during login.
            // Default behavior is to just match it directly, as if you'd done this:

            return email;
          }
        }
      },
      // An alternative: Twitter auth
      // auth: {
      //   strategy: 'twitter',
      //   options: {
      //     consumerKey: 'xxxx',
      //     consumerSecret: 'xxxx',
      //     callbackURL: 'http://my.example.com:3000/twitter-auth'
      //   }
      // },

      // Serve static files
      static: __dirname + '/sample-public',

      // Lock all URLs beginning with this prefix to require login. You can lock
      // an array of prefixes if you wish . Prefixes must be followed by / or . or
      // be matched exactly. To lock everything except the login mechanism itself,
      // use locked: true
      locked: '/new',

      // If you're using locked: true you can make exceptions here
      // unlocked: [ '/welcome' ]

      // Choose your own please
      sessionSecret: 'whatever',

      sessionCore: {
        // You can pass options directly to express-sessions here to customize
        // sessions generally, including passing a custom store, see the
        // express-sessions documentation
      }

      sessionStore: {
        // You can pass options directly to connect-mongo here to customize session storage
      },

      // Redirects to this host if accessed by another name
      // (canonicalization). This is pretty hard to undo once
      // the browser gets the redirect, so use it in production only
      // host: 'my.example.com:3000',

      // Database configuration
      db: {
        // MongoDB URL to connect to
        uri: 'mongodb://localhost:27017/example',

        // These collections become available as appy.posts, etc.
        collections: [ 'posts' ]

        // If I need indexes I specify that collection in more detail:
        // [ { name: 'posts', index: { fields: { { title: 1 } }, unique: true } } ]
        // Or more than one index:
        // [ { name: 'posts', indexes: [ { fields: { { title: 1 } } }, ... ] } ]
      },

      // This is where your code goes! Add routes, do anything else you want to do,
      // then call appy.listen
      ready: function(app, db) {
        app.get('/', function(req, res) {
          appy.posts.find().sort({created: -1}).toArray(function(err, posts) {
            res.send('messages: ' + posts.map(function(post) { return post.message; }).join());
          });
        });
        app.get('/new/:message', function(req, res) {
          var post = { 'message': req.params.message, 'createdAt': new Date() };
          appy.posts.insert(post, function(err) {
            res.send('added');
          });
        });

        // Listens on port 3000 on all IPV4 addresses,
        // unless otherwise configured via `data/port` and
        // `data/address` files, or the `PORT` and
        // `ADDRESS` environment variables

        // You can also call appy.listen('ip.address', 3001)
        // Or, appy.listen(3001)
        appy.listen();
      }
    });

## Alternate strategies for logging users in

The `strategy` option can be:

* `local`, which supports a MongoDB collection of user objects
* `twitter`, which uses Twitter authentication
* A custom function; see the `local` and `twitter` strategy functions in `appy.js` for examples

Whichever you use, once a user logs in `req.user` is always populated.

## The beforeSignin callback

When users log in via Twitter, some developers will want to do more than just serialize the user object into the session. For instance, I often need to capture Twitter tokens so I can tweet on a user's behalf. To achieve this, just add an options.beforeSignin callback function. The first argument is an error if any, the second is the user object. Note that the Twitter strategy makes the Twitter token and tokenSecret available as properties of the user object, which you can save for later.

The local strategy, on the other hand, will display a message to the user and give them another chance to log in if `err` is an object with a `message` property.

## Appy, Template Languages and Partials

By default Appy configures the Jade template language for you.

If you wish to use an alternative template language instead of Jade, pass your own viewEngine function, like this one:

    viewEngine: function(app) {
      var nunjucks = require('nunjucks');
      var env = new nunjucks.Environment(new nunjucks.FileSystemLoader(__dirname + '/views'));
      env.express(app);
    }

Regardless of the template language you choose, Appy adds support for partials. Express 3.0 does not include partials by default, and takes the position that providing partials is up to the template language. My feeling is that robust partials with their own, separate namespace are essential to build complex pages without bugs.

To use Appy's partials in Jade, just call the `partial` function. Make sure you use `!=` so that the result is not double-escaped:

    != partial('nameOfTemplate', { color: green, age: 1 });

In Nunjucks you would write:

    {{ partial('nameOfTemplate', { color: green, age: 1 }) }}

## Appy, users, and mongodb

Appy's `local` auth strategy supports storing users in MongoDB. The rule is very simple: you must have a MongoDB collection with...

* Either a `username` property, an `email` property, or both. Either is acceptable when logging in
* A password property, containing a hashed password as generated by the [password-hash](https://npmjs.org/package/password-hash) npm module, or one compatible with the function you supply as the `verify` option to the `local` strategy. Plaintext passwords are quite deliberately NOT supported.

By default, appy will look for a collection called `users`. If this is not what you want, just set the `collection` option when configuring your auth strategy, for instance:

```javascript
    auth: {
      strategy: 'local',
      options: {
        // Hardcoded users are handy for testing and for simple sites
        users: {
          admin: {
            username: 'admin',
            password: 'demo'
          }
        },
        // This is the default name for the users mongodb collection
        collection: 'mycollectionname'
      }
    }
```

The `username` property is generally specific enough that it only matches users. But the use of the `email` property poses a problem if the same collection also contains objects with email addresses that are not considered users. To accommodate this, you may pass an `extraLoginCriteria` option that only matches users:

```javascript
    auth: {
      strategy: 'local',
      options: {
        // Hardcoded users are handy for testing and for simple sites
        users: {
          admin: {
            username: 'admin',
            password: 'demo'
          }
        },
        // This is the default name for the users mongodb collection
        collection: 'mycollectionname',
        extraLoginCriteria: {
          type: 'person'
        }
      }
    }
```

*Hardcoded users win* in case of any conflict.

## Prefixing All URLs

To accommodate the occasional demand to run a node site in a subdirectory rather than a subdomain, we've added support for prefixing all URLs.

If you set the `prefix` option, it will be:

* Prepended to the static route for assets
* Prepended automatically to *every app.get, app.post, etc. route*
* Prepended automatically to res.redirect URLs if they are not fully absolute
* Prepended to all URLs in CSS output by the LESS compiler middleware

This way code intended for a site hosted at the root of a website can work without modification when the entire site is prefixed, or be moved back to an unprefixed site later.

With this feature, your reverse proxy server can proxy different prefixed URLs of the same website to different node apps.

Of course it is your responsibility to arrange your frontend JavaScript code to respect the prefix also.

For your convenience a `prefixCssUrls` method is exported. You can use this method to prefix CSS URLs in a compatible way in CSS that you are outputting by other means.

## BLESS support

If you are using the LESS middleware and are generating more than 4,095 CSS rules from a single LESS file, you'll want to turn on the `bless` option with `bless: true`. This splits the CSS into multiple files at the 4,095 selector limit so that <=IE9 doesn't fail to read those rules.

## Changelog

0.5.12: new `emailMatch` option to the local strategy. If provided, this must be a function which returns either a string (for a literal match) or a regular expression (for a case insensitive match or other fuzzy match). This will be used to compare email addresses to what the user typed in the username field, for both hardcoded and mongodb users. The default behavior is unchanged.

0.5.11: `log` option can be used to provide a function that takes an verb and an object containing details and logs that information as you see fit. `appy` invokes this function in various scenarios when users succeed or fail in logging in via the local strategy.

0.5.10: The `sessions` option, while still accepted, has been deprecated in favor of `sessionStore` because it configures `connect-mongo`. A new `sessionCore` option has also been added and it directly configures `express-session`.

0.5.9: reporting an error from the passport deserializer just shows a code trace to the end user which is inappropriate, plus the user is unable to log out and try to log in again, etc. because their session is stuck. Instead, clear their session in this situation.

0.5.7, 0.5.8: updated `connect-mongo` to get support for the `ttl` option.

0.5.6: optional support for `appy.listen('ip.address', 3001)`. Thanks to Jeremiah Harlan.

0.5.5: whoops, docs link pointed to an old repo.

0.5.4: You may pass `passport` to appy via the `passport` option. This is helpful if you are writing multiple modules that all add authorization strategies. Require `passport` in your top-level app, and pass it to all of your modules. If you don't do this, appy still requires `passport` on its own, so there is no bc break.

0.5.3: optional BLESS support.

0.5.2: temporarily depend explicitly on the MongoDB 1.4.8 driver, because 1.4.9 has a crashing bug affecting Apostrophe sites.

0.5.0: support for the `prefix` option, which allows you to prefix all URLs throughout the site. Express functions like `.get`, `.post`, etc. automatically prepend the prefix. So does `res.redirect`.

0.4.11: Deep-clone the hardcoded user before logging them in so there's no risk of modifications to the original array of users. Then delete their password property so there is no risk it will be accidentally exposed by application code.

0.4.9: the local strategy's redirect callback may now take two arguments, `req` and `callback`. This allows asynchronous work to be done before invoking the callback with the URL. The URL to redirect to is the only argument to the callback.

0.4.8: bumped mongodb driver dependency to 1.4.x. The 1.3.x driver rejects `$or` in remove commands when talking to MongoDB server version 2.6.x.

0.4.7: don't crash if the port is an actual number and not a string representation of a number (this happens when neither `PORT` nor `data/port` is found and 3000 is assumed).

0.4.6: optional support for specifying the address to listen on, as well as the port number. The `ADDRESS` environment variable is supported, also the `data/address` file. For Unix socket connections just use `port` to specify the UNIX socket path. Thanks to [Jeff Walter](https://github.com/jeffwalter).

0.4.0:

* If your application stores more than one kind of object in the same collection, then when searching for a user by email address you may accidentally pick up an object that is not considered a user. The new `extraLoginCriteria` option allows you to filter out objects that are not users in any way you see fit.

0.1.33:

* Enable the `express.compress` middleware by default. So far we've had no trouble with this and it's a nice performance win. However you can disable it by setting the `compress` option to `false` in your appy configuration.

0.1.32:

* When using the local strategy, users stored in MongoDB are refreshed from the database on each request. The performance hit is justified mainly by the need to lock out users whose accounts have been deleted immediately. In addition we can see changes to the user's profile immediately.

0.1.31:

* connect to MongoDB via [MongoClient](http://mongodb.github.io/node-mongodb-native/driver-articles/mongoclient.html). This gives us sensible defaults for many MongoDB options, including `auto_reconnect` for improved stability. The old `db.host`, `db.port`, etc. options are still supported and we build , but `db.uri` is preferred and gives you much more flexibility. See the [MongoClient docs](http://mongodb.github.io/node-mongodb-native/driver-articles/mongoclient.html).

* Session storage change: replaced the unsupported `connect-mongodb` module with the actively maintained `connect-mongo` module. With this change, sessions expire after two weeks by default, rather than never expiring, which tends to create an enormous database after a while. Also, you can pass options to `connect-mongo` via the `sessions` option to appy, so you are not stuck with this default. No code changes are required on existing projects. Existing sessions are automatically migrated and their two-week expiration period begins at the time of first launch after the upgrade.

0.1.30: modern versions of the mongodb and async modules. No change in behavior.

0.1.28: The req.query object is now available to the login template as the `query` property. This is helpful in displaying additional situation-dependent messages to users beyond the simple flash `message` property.

0.1.27: users may now log in with either their email address or their username when using the local strategy. Specifically, `appy` checks for both the `username` property and the `email` property. For safety, `appy` always makes sure the name the user has entered is not empty, so that this feature can't be used to test common passwords against the set of all users who do not have an email address.

## About P'unk Avenue and Apostrophe

`appy` was created at [P'unk Avenue](http://punkave.com) for use in many projects built with Apostrophe, an open-source content management system built on node.js. Appy isn't mandatory for Apostrophe and vice versa, but they play very well together. If you like `appy` you should definitely [check out apostrophenow.org](http://apostrophenow.org). Also be sure to visit us on [github](http://github.com/punkave).

## Support

Feel free to open issues on [github](http://github.com/punkave/appy).

<a href="http://punkave.com/"><img src="https://raw.github.com/punkave/appy/master/logos/logo-box-builtby.png" /></a>




