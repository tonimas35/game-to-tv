'use strict';
/*
 * A FAKE of LG's `webos-service` module (the real one only exists on the TV):
 * enough of its API for src/tv-service/ to be tested on a PC.
 *
 *   const s = new Service('io.x.service');
 *   s.register(name, handler(message), cancelHandler(message))
 *   s.activityManager.create(name, cb(activity)) / .complete(activity, cb)
 * Test side:
 *   s.call(method, payload, onResponse) -> message (with .responses, .cancel())
 *   s.request(method, payload) -> Promise of the first response
 *   Service.instances: every instance created (for the boot test)
 * Must run on Node 12 too (test/tele.test.js boots the packaged service with it).
 */
var nextToken = 1;

function FakeActivityManager() {
  this.created = [];
  this.completed = [];
}
FakeActivityManager.prototype.create = function (name, cb) {
  var a = { activityId: this.created.length + 1, name: name };
  this.created.push(a);
  setImmediate(function () { cb(a); });
};
FakeActivityManager.prototype.complete = function (activity, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  this.completed.push(activity);
  if (cb) setImmediate(function () { cb(activity); });
};
FakeActivityManager.prototype.active = function () {
  var done = this.completed;
  return this.created.filter(function (a) { return done.indexOf(a) < 0; });
};

function Service(busId) {
  this.busId = busId;
  this.methods = {};
  this.activityManager = new FakeActivityManager();
  Service.instances.push(this);
}
Service.instances = [];

Service.prototype.register = function (name, handler, cancel) {
  this.methods[name] = { handler: handler, cancel: cancel };
  return { on: function () {} };
};

Service.prototype.call = function (method, payload, onResponse) {
  var m = this.methods[method];
  if (!m) throw new Error('Método no registrado: ' + method);
  payload = payload || {};
  var msg = {
    method: method,
    payload: payload,
    isSubscription: !!payload.subscribe,
    uniqueToken: String(nextToken++),
    responses: [],
    cancelled: false,
    respond: function (r) {
      if (msg.cancelled) throw new Error('La suscripción está cancelada');
      msg.responses.push(r);
      if (onResponse) onResponse(r);
    },
    cancel: function () {
      if (msg.cancelled) return;
      msg.cancelled = true;
      if (m.cancel) m.cancel(msg);
    }
  };
  m.handler(msg);
  return msg;
};

Service.prototype.request = function (method, payload) {
  var self = this;
  return new Promise(function (resolve) {
    var done = false;
    self.call(method, payload, function (r) { if (!done) { done = true; resolve(r); } });
  });
};

module.exports = Service;
