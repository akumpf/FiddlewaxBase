//
// Email-only authentication
//
// Special thanks to The Chaos Collective where most of this
// open source code began -- http://chaoscollective.org
//
// Note: Your node setup will need a persistant sessionStore
//       and should use SSL so that URLs aren't easily read.
//
//
var _           = require('underscore');
var crypto      = require('crypto');
var nodemailer  = require("nodemailer");
var request     = require('request'); 
// ---
var defaultOptions = {
  tokenExpireMS:        1000*60*5, // 5 minutes
  app_name:             "Test App",
  app_url_base:         "http://...",
  app_url_postlogin:    "http://...",
  app_url_postlogout:   "http://...",
  email_service:        "Gmail",
  email_from:           "asdf@gmail.com",
  email_from_name:      "EmailAuth Helpdesk",
  email_user:           "asdf@gmail.com",
  email_pass:           "passwordz",
  email_login_subject:  "EmailAuth: Login Key for ${APP_NAME} -- @${DATE_B36_M4}",  
  email_login_bodyHTML: "Hello from <b>${APP_NAME}</b>.<h3>Here is your requested access key.</h3><br/><h2><a style='text-decoration: none; font-weight: 600;' href='${CONFIRM_URL}' target='${LINK_TARGET}'>Click to Sign In to ${APP_NAME}</a></h2><br/>This is a single-use link and must be verified within ${TOKEN_TIME} to validate. Do not forward or share this email with anyone else.<br/><br/>&mdash; see you soon!<br/><br/>The ${APP_NAME} Team<br/><br/><span style='font-size: 11px; color: #777;'>- - - - - - -<br/><br/>If you did not request a login key and are recieving this email in error, please let us know by replying to this message.<br/>For your records, this login request was made from IP: ${FROM_IP}</span>"
}; 
// --
// Alternatively, you can specify email provider directly via host/ssh/port params and they'll override the service.
// email_smtpHost:       "smtp.mailgun.org",
// email_ssl:            true,
// email_port:           465,
// --
function _getNewRandomToken(cb){
   crypto.randomBytes(32, function(ex, buf) {
    var token = buf.toString('base64').replace(/\//g,'a').replace(/\+/g,'b').replace(/\=/g, '');
    cb(token);
  });
}
function _emailIsNotValid(email){
  if(!email || email.length < 5 || email.indexOf("@") <= 0 || email.indexOf(".") < 0){
    return true;
  }
  return false;
}
function _prepareEmail(email){
  return (email||"").replace(/^\s+/, '').replace(/\s+$/, '').toLowerCase();
}
function _getClientIp(req) {
  var ipAddress;
  var forwardedIpsStr = req.header('x-forwarded-for'); 
  if(forwardedIpsStr){
    ipAddress = forwardedIpsStr.split(',')[0];
  }
  if(!ipAddress){
    ipAddress = req.connection.remoteAddress;
  }
  return ipAddress;
}
// ---
exports.init = function(options){
  if(!options.sessionStore){
    return console.log("fail: no sessionStore defined in eauth options.");
  }
  if(!options.app){
    return console.log("fail: no app defined in eauth options.");
  }
  console.log("eauth: initializing");
  options = _.defaults(options || {}, defaultOptions);
  // --
  function sendAuthEmail(useremail, token, linkTarget, fromIP, cb){
    var subject = options.email_login_subject;
    subject = subject.replace(/\$\{APP_NAME\}/g, options.app_name);
    subject = subject.replace(/\$\{DATE_BASE32\}/g, new Date().getTime().toString(32));
    subject = subject.replace(/\$\{DATE_B36_M4\}/g, (new Date().getTime()%1679615).toString(36)); // 4 base-36 chars
    linkTarget = linkTarget||"_blank";
    // --
    var bodyHTML = options.email_login_bodyHTML;
    var tokenURL = options.app_url_base+"/act/emailauth_confirm/?token="+token;
    bodyHTML = bodyHTML.replace(/\$\{CONFIRM_URL\}/g, tokenURL);
    bodyHTML = bodyHTML.replace(/\$\{URL_BASE\}/g, options.app_url_base);
    bodyHTML = bodyHTML.replace(/\$\{APP_NAME\}/g, options.app_name);
    var tokenMin = Math.floor(options.tokenExpireMS/(60*1000))+" minutes";
    bodyHTML = bodyHTML.replace(/\$\{TOKEN_TIME\}/g, tokenMin);
    bodyHTML = bodyHTML.replace(/\$\{LINK_TARGET\}/g, linkTarget);
    bodyHTML = bodyHTML.replace(/\$\{FROM_IP\}/g, fromIP);
    // --
    var mailOptions = {
      from:    options.email_from_name+" <"+options.email_from+">",
      to:      useremail, // list of receivers
      subject: subject, // Subject line
      html:    bodyHTML, // html body
      generateTextFromHTML: true
    };
    smtpTransport.sendMail(mailOptions, function(err, response){
      if(err){
        console.log(err);
        return cb("ERROR SENDING EMAIL to "+useremail);
      }else{
        console.log("auth: sent login for " + useremail);
        return cb(null);
      }
    });
  }
  function getAuthToken(req, useremail, ip, cb){
    if(!sessionStore) return cb("0"); // no session store available.
    if(!req.sessionID) return cb("0"); // no session ID found.
    _getNewRandomToken(function(token){
      var t = new Date().getTime();
      var d = {
        sid: req.sessionID, 
        time: t, 
        type: "eauthtoken",
        cookie: {
          expires:  t + (options.tokenExpireMS||0) //new Date(new Date().getTime() + options.tokenExpireMS||0)
        },
        email: useremail,  
        ip: ip
      };
      //console.log(d);
      sessionStore.set(token, d, function(err) { 
        if (err){
          console.log(err);
          return cb("0");
        }
        return cb(token);
      });
    });
  }
  // --
  var sessionStore  = options.sessionStore;
  var app           = options.app;
  var eauth         = {};
  var smtpTransport = null;
  if(!options.email_smtpHost){
    // SERVICE
    smtpTransport = nodemailer.createTransport("SMTP",{
      service: options.email_service,
      auth: {
        user: options.email_user,
        pass: options.email_pass
      }
    });
  }else{
    // DIRECT SMTP HOST CONFIG
    smtpTransport = nodemailer.createTransport("SMTP",{
      host:             options.email_smtpHost, // hostname
      secureConnection: options.email_ssl,      // use SSL
      port:             options.email_port,     // port for secure SMTP
      auth: {
        user: options.email_user,
        pass: options.email_pass
      }
    });
  }
  // --
  app.get("/act/emailauth_login", function(req, res){
    if(!req.session) return res.end("ERROR: No session object.");
    if(req.session.auth && req.session.auth.loggedin){
      //console.log(req.session.auth);
      return res.redirect(options.app_url_postlogin);
    } 
    var recaptchaHTML = "<br/><br/>";
    var onclick = "";
    if(options.recaptchaPrivKey){
      recaptchaHTML = "<br/><br/>Are you a robot?<br/>"+
        "<script type='text/javascript'>var RecaptchaOptions = {theme : 'white'};</script>"+
        "<script type='text/javascript' src='https://www.google.com/recaptcha/api/challenge?k="+options.recaptchaPubKey+"'></script>"+
        "<br/>";
      onclick="_gaq.push(['_trackEvent', 'Users', 'Login']);";
    }
    res.end("<html><head><title>Sign In</title></head><body style='padding: 25px; font-family: Arial; background: #EEE; color: #333;'><form method='post' action='/act/emailauth_login' onsubmit='if(window.formWasSubmitted) return false; window.formWasSubmitted = true; return true;'>Sign In to "+options.app_name+" with your email address:<br/><input style='width: 318px; padding: 5px; font-size: 14px; margin-top: 10px;' type='email' name='email' placeholder='yourname@email.com' />"+
    recaptchaHTML+
    "<input type='submit' style='border: none; border-radius: 0; background: #333; color: #FFF; line-height: 34px; cursor: pointer; position: relative; font-size: 16px; width: 318px;' value='Sign In' onclick=\""+onclick+"\" /></form><div style='font-size: 12px; position: relative; width: 270px;'>Don't have an account yet?<br/>No worries, just sign in above and we'll help you get started.</div><br/><div style='font-size: 11px; color: #777; position: relative; width: 320px;'>Note: Enter your own email address only. Your IP address and connection information will be logged for security purposes.</div></body></html>");
  }); 
  app.post("/act/emailauth_login", function(req, res){
    if(!req || !req.body || !req.body.email) return res.end("ERROR: No Email.");
    var useremail = req.body.email;
    var linkTarget = req.body.tgt || "_blank";
    if(!req.sessionID) return res.end("ERROR: No Session.");
    useremail = _prepareEmail(useremail);
    var ip = _getClientIp(req);
    if(_emailIsNotValid(useremail)) return res.end("ERROR: Invalid Email.");
    function doLogin(){
      getAuthToken(req, useremail, ip, function(token){
      if(!token) return res.end("ERROR: No Token.");
      //console.log("sending email auth to: "+useremail);
      sendAuthEmail(useremail, token, linkTarget, ip, function(err){
        if(err){
          console.log("failed to send email to: "+useremail);
          return res.end("ERROR: Email Failed To Send; Retry Later.");
        }
        res.end("<html><head><title>Email Sent</title></head><body style='padding: 25px; font-family: Arial; background: #EEE; color: #333;'><h2>Email Sent</h2>Please check your inbox and click the <b>Sign In</b> link.<br/><br/>See you soon!</body></html>");
        if(options.onloginattempt){
          options.onloginattempt(useremail, null, ip);
        }
      });
    });
    }
    if(options.recaptchaPrivKey){
      //console.log("eauth: checking captcha.");
      request.post({
        url: 'http://www.google.com/recaptcha/api/verify', 
        method: "POST", 
        form: {
          privatekey: options.recaptchaPrivKey,
          remoteip:   ip,
          challenge:  req.body.recaptcha_challenge_field||"",
          response:   req.body.recaptcha_response_field||""
        }
      }, function(err, r, body){
        if(err){
          console.log(err);
          log4("eauth: bypassing captcha for now...");
          return doLogin();
        }
        var bs = (body||"").split("\n");
        if(bs[0] === "true"){
          //log1("eauth: recaptcha passed.");
          return doLogin();
        }else{
          // fail.
          console.log("eauth: failed recaptcha ->", bs);
          return res.redirect("/");
        }
      });
    }else{
      return doLogin();
    }
  });
  app.get("/act/emailauth_confirm", function(req, res){
    if(!req || !req.query || !req.query.token) return res.end("0");
    var token = req.query.token;
    var ip = _getClientIp(req);
    sessionStore.get(token, function(err, data){
      if(err) return res.end("ERROR: Invalid token request");
      //console.log(data);
      var t = new Date().getTime();
      if(!data){
        return res.end("<html><head><title>Confirm</title></head><body style='padding: 25px; font-family: Arial; background: #EEE; color: #333;'><h2>Whoops!</h2><br/><b>Your temporary login token was not found.</b><br/><br/><br/>Did you submit your email address too long ago?<br/>Perhaps you should <a href='"+options.app_url_base+"/act/emailauth_login'>login again</a>.</body></html>");
      }
      if(data.type !== "eauthtoken" || !data.email || !data.ip || !data.cookie || !data.cookie.expires || data.cookie.expires < t){
        return res.end("ERROR: Expired.");
      }
      var emailmd5 = crypto.createHash('md5').update(data.email).digest('hex');
      var usericon = "http://www.gravatar.com/avatar/"+emailmd5+".png?s=50&d=mm";
      var userinfo = "www.gravatar.com/"+emailmd5+".json";
      // OK! now remove the token and mark the user as logged in with their info.
      sessionStore.destroy(token, function(){
        sessionStore.get(token, function(err, d2){
          if(err || d2){
            console.log(err);
            console.log(d2);
            return res.end("ERROR: Session not be closed. aborting.");
          }
          //req.session.auth = {email: data.email, loginip: data.ip, confirmip: ip, loginat: t, emailmd5: emailmd5, usericon: usericon, userinfo: userinfo, loggedin: true};
          req.session.auth = {email: data.email, loginip: data.ip, confirmip: ip, loginat: t, emailmd5: emailmd5, loggedin: true};
          if(options.onconfirm){
            options.onconfirm(data.email, usericon, ip, req, res, function(){
              res.redirect(options.app_url_postlogin);
            });
          }else{
            res.redirect(options.app_url_postlogin);  
          }
        });
      });
    });
  });
  app.get("/act/emailauth_logout", function(req, res){
    if(!req.session) return res.end("ERROR: No session object.");
    if(!req.session.auth || !req.session.auth.loggedin){
      return res.redirect(options.app_url_postlogout);
    }
    res.end("<html><head><title>Logout</title></head><body style='padding: 25px; font-family: Arial; background: #EEE; color: #333;'><form method='post' action='/act/emailauth_logout'>Are you sure you want to leave?<br/><input style='width: 270px; padding: 5px; font-size: 14px; margin-top: 10px;' type='submit' value='Logout'/></form></body></html>");
  });
  app.post("/act/emailauth_logout", function(req, res){
    //console.log("logging out.");
    var user = (req.session||{}).auth||{};
    var ip = _getClientIp(req);
    if(req.session && req.session.auth){
      delete req.session.auth;
    }
    req.session.destroy();
    res.redirect(options.app_url_postlogout);
    if(user.email && options.onlogout){ 
      options.onlogout(user.email, user.usericon, ip);
    }
  });
  // --
  eauth.sendEmailTo = function(useremail, subject, bodyHTML, cb){
    useremail = _prepareEmail(useremail);
    if(_emailIsNotValid(useremail)) return cb("ERROR: Invalid Email.");
    // --
    var mailOptions = {
      from:    options.email_from_name+" <"+options.email_from+">",
      to:      useremail, // list of receivers
      subject: subject,   // Subject line
      html:    bodyHTML,  // html body
      generateTextFromHTML: true
    };
    smtpTransport.sendMail(mailOptions, function(err, response){
      if(err){
        console.log(err);
        return cb("ERROR SENDING EMAIL to "+useremail);
      }else{
        console.log("eauth: sent email to " + useremail);
        return cb(null);
      }
    });
    // --
  };
  // --
  // return inner exports
  return eauth;
};

