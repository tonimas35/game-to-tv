'use strict';
/*
 * Drivers: how to put the game screen on each kind of TV.
 *
 * Every driver is an object with this shape (see docs/drivers.md):
 *
 *   {
 *     id: 'webos',                 // used in the config and in --driver
 *     name: 'LG webOS',
 *     description: '…',            // Spanish, shown by `tv add` / `doctor`
 *     capabilities: { discover, pair, install, launch, control, screenshot, perf },  // booleans
 *
 *     discover({ timeout })        -> [{ name, ip, model, driver }]
 *     pair(tv, { onPrompt })       -> { clientKey }      saved in the config by the CLI
 *     install(tv, { serverUrl, ipkOnly, outDir, log })   -> { installed, ... }
 *     launch(tv, { serverUrl, path })                    -> { opened | url }
 *     toast(tv, message)                                  (control)
 *     sendKey(tv, 'UP' | 'ENTER' | 'BACK' | ...)          (control)
 *     screenshot(tv, outFile)      -> { file }
 *     info(tv)                     -> { ... }
 *     perf(tv, { seconds })        -> { fps, frames, worstMs, ... }
 *   }
 *
 * `tv` is the config entry: { name, driver, ip, clientKey?, appId?, aresDevice? }.
 * A missing method means "not supported": the CLI explains it in Spanish.
 */
const { DriverError } = require('./errors');

const DRIVERS = {
  webos: require('./webos'),
  android: require('./android'),
  browser: require('./browser'),
  firetv: require('./firetv')
};

function list() { return Object.keys(DRIVERS).map(function (k) { return DRIVERS[k]; }); }

function get(id) {
  const d = DRIVERS[id];
  if (!d) throw new DriverError('Driver desconocido: «' + id + '». Disponibles: ' + Object.keys(DRIVERS).join(', '), 'ENODRIVER');
  return d;
}

const CAPABILITY_TEXT = {
  discover: 'buscar teles en la red',
  pair: 'emparejar',
  install: 'instalar la app',
  launch: 'abrir los juegos',
  control: 'controlar la tele (avisos, botones)',
  screenshot: 'hacer capturas de pantalla',
  perf: 'medir los FPS'
};

/** Throws a helpful error if the driver cannot do `cap`. */
function requireCapability(driver, cap, method) {
  if (driver.capabilities && driver.capabilities[cap] && typeof driver[method || cap] === 'function') return;
  const extra = driver.unsupportedHelp ? '\n' + driver.unsupportedHelp(cap) : '';
  throw new DriverError('El driver «' + driver.id + '» (' + driver.name + ') no sabe ' + (CAPABILITY_TEXT[cap] || cap) + '.' + extra, 'EUNSUPPORTED');
}

module.exports = { list: list, get: get, requireCapability: requireCapability, CAPABILITY_TEXT: CAPABILITY_TEXT, DriverError: DriverError };
