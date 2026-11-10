'use strict';
// Runs as the Internet-enabled OAP UID, not root; credentials arrive only on stdin.
var transport=require('./agent').transport,fs=require('fs'),path=require('path');
var raw='';process.stdin.on('data',function(b){raw+=b;if(raw.length>600000)process.exit(1);});
process.stdin.on('end',function(){
    var input;
    try{input=JSON.parse(raw);}catch(e){console.error('Invalid worker request');process.exit(1);return;}
    // transport can accept an in-memory DNS lease through this scoped helper.
    var dns=require('dns'),original=dns.lookup;
    if(input.lease&&Array.isArray(input.lease.dns)&&input.lease.dns.length){var resolver=new dns.Resolver();resolver.setServers(input.lease.dns);dns.lookup=function(host,opts,cb){if(typeof opts==='function'){cb=opts;opts={};}resolver.resolve4(host,function(e,a){if(opts&&opts.all)cb(e,a&&a.map(function(ip){return {address:ip,family:4};}));else cb(e,a&&a[0],4);});};}
    transport(input.server,input.endpoint,input.key,input.body,null).then(function(value){process.stdout.write(JSON.stringify({value:value}));},function(e){process.stdout.write(JSON.stringify({error:e.message}));});
});
