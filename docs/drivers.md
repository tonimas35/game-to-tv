# Drivers: cómo poner los juegos en otra tele

Un **driver** es el código que sabe hablar con un tipo de pantalla. Están en
`src/drivers/<id>/` y se registran en [`src/drivers/index.js`](../src/drivers/index.js).

| Driver | Estado | Qué hace |
|---|---|---|
| `webos` | ✅ | LG webOS: SSDP, emparejamiento SSAP, app lanzadora (`.ipk`), avisos, botones, capturas, FPS por DevTools. |
| `browser` | ✅ | Cualquier pantalla con navegador: solo da la dirección (y un QR). |
| `firetv` | 🔜 | Esqueleto con el plan ([README](../src/drivers/firetv/README.md)). |

## La interfaz

```js
module.exports = {
  id: 'mitele',                         // se usa en --driver y en config.json
  name: 'Mi Tele',                      // para mostrar
  description: 'Teles de la marca X…',  // en español
  capabilities: {                       // true solo si está implementado
    discover: false, pair: false, install: false, launch: true,
    control: false, screenshot: false, perf: false
  },

  async discover({ timeout }) { return [{ name, ip, model, driver: 'mitele' }]; },
  async pair(tv, { onPrompt }) { return { clientKey: '…' }; },        // el CLI la guarda
  async install(tv, { serverUrl, ipkOnly, outDir, log }) { return { installed: true }; },
  async launch(tv, { serverUrl, path }) { return { opened: 'app' }; }, // o { url, message } si solo puede indicar la dirección
  async toast(tv, message) {},           // capacidad «control»
  async sendKey(tv, button) {},          // capacidad «control»: 'UP', 'ENTER', 'BACK'…
  async screenshot(tv, outFile) { return { file: outFile }; },
  async info(tv) { return {}; },
  async perf(tv, { seconds }) { return { fps, frames, worstMs, width, height, dpr }; },

  // Opcional: texto de ayuda cuando se pide algo que no sabe hacer
  unsupportedHelp(capability) { return 'Mientras tanto, usa el driver «browser».'; }
};
```

- `tv` es la entrada de la configuración más su nombre:
  `{ name: 'salon', driver: 'webos', ip: '192.168.1.50', clientKey, appId, aresDevice }`.
- Los mensajes de error para el usuario van en español: lanza
  `DriverError` (`src/drivers/errors.js`) y el CLI los muestra tal cual.
- Si la tele entrega una clave nueva al reconectar, llama a `opts.onKey(clave)`:
  el CLI la guarda.
- No ejecutes nada que cambie el sistema del usuario sin que lo pida un
  comando explícito (`install`, `open`…).

## Pasos para añadir un driver

1. Crea `src/drivers/<id>/index.js` con la interfaz de arriba (empieza con las
   capacidades a `false` y ve activándolas).
2. Regístralo en `DRIVERS` de `src/drivers/index.js`.
3. Si necesita una app en la tele, ponla en `apps/<id>-launcher/` con la URL
   del servidor como marcador (mira `apps/webos-launcher/` y
   `src/drivers/webos/launcher.js`): la app debe **esperar al servidor** y
   luego navegar a él, con una pantalla «No encuentro el servidor… reintentando».
4. Si hay herramientas externas (como `ares-cli` o `adb`), búscalas en el
   `PATH` y, si faltan, explica **los pasos exactos** para instalarlas.
5. Pruebas en `test/<id>.test.js` **sin tele real**: un servidor falso que hable
   el protocolo (mira `test/helpers/fake-tv.js`) y comandos falsos en un `PATH`
   temporal (como los `ares-*` de `test/webos.test.js`).
6. Documenta la puesta en marcha en `docs/tele-<marca>.md` y añade la fila en
   la tabla de pantallas del README.

## Cómo está hecho el de LG (`src/drivers/webos/`)

| Archivo | Qué hace |
|---|---|
| `ssdp.js` | M-SEARCH a `239.255.255.250:1900` con `ST: urn:lge-com:service:webos-second-screen:1`; lee `LOCATION` y el nombre de `DLNADeviceName.lge.com`, y el XML de descripción (modelo). |
| `ssap.js` | Cliente SSAP: `wss://IP:3001` (certificado autofirmado) o `ws://IP:3000`; registro con aviso (`pairingType: PROMPT`) y `client-key`; peticiones; botones por el socket de puntero (`type:button\nname:UP\n\n`); llamadas `luna://` con el truco de la alerta; captura con `ssap://tv/executeOneShot`. |
| `manifest.js` | Manifiesto y permisos que se piden al emparejar. |
| `launcher.js` | Copia la plantilla, mete la URL del servidor y pone la versión en el nombre de los iconos. |
| `ipk.js` | `.ipk` en JavaScript puro (`ar` + `tar.gz`). |
| `ares.js` | Ejecuta `ares-setup-device`, `ares-package`, `ares-install`, `ares-inspect` y escribe los pasos si faltan. |
| `cdp.js` | Mide FPS con `Runtime.evaluate` (`requestAnimationFrame` durante N s) por el protocolo de DevTools. |

Ideas para otras marcas: [roadmap.md](roadmap.md).
