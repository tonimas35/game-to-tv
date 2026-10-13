# Crear un juego

Esta guía construye, paso a paso, **«Reflejos»**: la tele muestra «Preparados…»,
y tras una espera al azar sale **«¡YA!»**. El primer móvil que toca gana el
punto; quien toca antes de tiempo queda fuera de esa ronda. Al mejor de 5,
de 2 a 6 jugadores.

El juego completo está en [`src/games/ejemplo-reflejos/`](../src/games/ejemplo-reflejos/)
y tiene sus pruebas en [`test/reflejos.test.js`](../test/reflejos.test.js).
Cópialo como punto de partida.

## 0. Lo que ya te da el hub

No tienes que programar nada de esto:

- El menú de la tele y del móvil (tu juego aparece solo, con su tarjeta).
- El QR, la entrada de jugadores (hasta 6 por defecto) con su nombre y color,
  y la **reconexión** (si un móvil se apaga, su sitio se guarda 30 s).
- Que nadie empiece tu juego con más o menos jugadores de los que admite: la
  tarjeta sale en gris con el motivo y, si alguien lo elige igualmente, la tele
  y los móviles lo explican («Pong» es de 2 a 4 jugadores y sois 6).
- Elegir juego con el mando o desde el móvil, y volver al menú (botón **Atrás**
  del mando o «Menú» en el móvil, con confirmación).
- Un bucle a **60 Hz con paso fijo** en el servidor.
- En la tele: sonidos, avisos, confeti, el límite de resolución de los canvas
  para webOS y el truco contra el salvapantallas.

Tu juego solo decide **qué pasa** (servidor) y **cómo se ve** (tele y móvil).

## 1. La carpeta y el manifiesto

```
src/games/ejemplo-reflejos/
  manifest.json   datos del juego (menú)
  index.js        lógica en el servidor (Node.js)
  tv.js           vista de la tele (navegador, ES2019)
  tv.css          estilos de la tele (opcional)
  phone.js        vista del móvil (navegador, ES2019)
  phone.css       estilos del móvil (opcional)
  icon.svg        dibujo de la tarjeta del menú (300x170)
```

`manifest.json`:

```json
{
  "id": "ejemplo-reflejos",
  "title": "Reflejos",
  "description": "La tele dice «¡YA!» y gana el punto quien antes toque su móvil. ¡Sin adelantarse! Al mejor de 5.",
  "phoneDescription": "Toca en cuanto la tele diga «¡YA!»",
  "minPlayers": 2,
  "maxPlayers": 6,
  "tags": ["Al mejor de 5", "Ejemplo"],
  "icon": "icon.svg",
  "accent": "#ffd23e",
  "order": 90
}
```

| Campo | Para qué |
|---|---|
| `id` | Igual que el nombre de la carpeta: minúsculas, números y guiones. |
| `title`, `description` | La tarjeta de la tele. |
| `phoneDescription` | Texto corto del botón en el móvil (si falta, se usa `description`). |
| `minPlayers`, `maxPlayers` | El hub no deja empezar con menos o más jugadores. La tarjeta muestra el rango («2 a 6 jugadores») y, si no encaja, el motivo. |
| `tags` | Etiquetas de la tarjeta (cortas: caben 2 o 3; el rango de jugadores ya lo pone el menú). |
| `icon` | Archivo de la carpeta que se dibuja en la tarjeta. |
| `accent` | Color del borde de la tarjeta cuando tiene el foco. |
| `order` | Posición en el menú (menor = antes). |
| `howTo` | Opcional: lista de frases «Cómo se juega» (llega a la tele y al móvil en `G2T.gameById(id).howTo`; «El Infiltrado» la enseña con su botón «?»). |

La sala tiene **6 huecos** por defecto (`game-to-tv start --jugadores N`, de 2
a 8). Cómo se hace un juego para varios: [sección 5](#5-de-2-a-6-jugadores).

## 2. El servidor: `index.js`

El módulo exporta `create(api)`, que devuelve un objeto con unas pocas
funciones. El hub lo crea al elegir el juego y lo para al volver al menú.

> **Node 12**: en las teles LG el servidor corre dentro de la tele (modo tele),
> con su Node.js 12. El `index.js` y lo que requiera no pueden usar `?.`, `??`,
> `||=`, campos de clase, `fs.rm`, `fetch`, `.at()`, `replaceAll`,
> `structuredClone`… `npm run check` lo comprueba.

```js
'use strict';
const SPEED = Math.max(0.1, parseFloat(process.env.REFLEJOS_DEBUG_SPEED) || 1);
const POINTS_TO_WIN = 3;                                   // al mejor de 5
const TIMES = { wait: [2000, 5000], go: 5000, point: 2500 }; // ms

function create(api, opts) {
  const random = (opts && opts.random) || Math.random;     // inyectable para las pruebas
  const S = { phase: 'ready', round: 0, left: 0, scores: [], early: [], last: null, winner: -1, goAt: 0, paused: false };
  let dirty = true, lastMetaAt = 0;

  function setPhase(phase, ms) { S.phase = phase; S.left = ms || 0; dirty = true; }
  function nextRound() {
    S.round++;
    S.early = [];
    setPhase('ready', TIMES.wait[0] + random() * (TIMES.wait[1] - TIMES.wait[0]));
  }
  function newMatch() {
    S.round = 0; S.scores = new Array(api.slots).fill(0); S.winner = -1; S.last = null;
    nextRound();
  }
  // ...tap(slot), tick(dt) y buildMeta(): ver el archivo completo

  return {
    start: newMatch,                       // al elegir el juego
    stop: function () {},                  // al salir (temporizadores, etc.)
    tick: tick,                            // 60 veces por segundo, dt = 1/60
    flush: function () {                   // tras cada tick: enviar el estado si ha cambiado
      if (dirty || Date.now() - lastMetaAt >= 1000) sendMeta();
    },
    onMessage: function (who, msg) {       // who = hueco del jugador (0, 1…) o -1 si es la tele
      if (who < 0) return;
      if (msg.t === 'r.tap') tap(who);
      else if (msg.t === 'r.again' && S.phase === 'end') newMatch();
    },
    onPlayerJoined: function (i) { api.sendSlot(i, buildMeta()); },   // también al reconectar
    onPlayerLeft: function (i) { /* se ha ido del todo: ver la sección 5 */ return true; },
    syncTv: function (ws) { api.sendWs(ws, buildMeta()); }            // una tele que se conecta a mitad
  };
}

module.exports = { create: create };
```

Ideas clave:

- **El servidor manda.** Los móviles solo envían intenciones (`r.tap`) y el
  servidor decide quién gana. Así no hay trampas ni desajustes.
- **Un único mensaje de estado** (`rmeta`) con todo lo público. Se envía cuando
  algo cambia (`dirty`) y, por si acaso, una vez por segundo. Así una tele o un
  móvil que se reconecta se pone al día solo.
- **Pausa si falta alguien**: `api.allConnected()` es `false` mientras un
  jugador está reconectando; el reloj se para.
- **Nombres de mensaje con prefijo** (`r.` aquí, `d.` en Dibuja) para no chocar
  con los del hub (`hello`, `join`, `pick`, `menu`, `hub`, `ev`…).

### La `api` que recibe el juego

| | |
|---|---|
| `api.slots` | Número de huecos de jugador de la sala (6 por defecto). |
| `api.players()` | Huecos ocupados, p. ej. `[0, 1, 2]`. **Puede tener huecos**: `[0, 2]` (ver la sección 5). |
| `api.name(i)` | Nombre del jugador del hueco `i`. |
| `api.isConnected(i)` · `api.allConnected()` | ¿Está conectado? ¿Lo están todos? |
| `api.COLORS[i]` | Color del jugador del hueco `i` (cian, magenta, amarillo, verde, naranja, violeta, blanco, menta: 8 distintos). |
| `api.broadcast(obj)` | A la tele y a todos los móviles. |
| `api.sendTvs(obj)` · `api.sendPhones(obj)` · `api.sendSlot(i, obj)` | Solo a la tele, a los móviles o a un jugador (p. ej. la palabra secreta en Dibuja). |
| `api.sendWs(ws, obj)` | A una conexión concreta (en `syncTv`). |
| `api.store(i)` | Datos del jugador que sobreviven entre partidas (ver «menú» abajo). |
| `api.galleryDir` | Carpeta para guardar archivos (la galería de dibujos). Puede ser `null` en una tele sin carpeta con permiso de escritura: entonces no guardes nada. |
| `api.log(texto)` | Escribe en la consola del servidor. |

Funciones opcionales del objeto del juego: `onPlayerDisconnected(i)`,
`onPlayerJoined(i, reconnect)`, `onPlayerLeft(i)`, `syncTv(ws)`, `flush()`.

### Cosas del menú (opcional)

Un juego puede añadir algo al **menú del móvil** que se guarde por jugador,
como las «palabras secretas» de Dibuja. En `index.js`:

```js
module.exports = {
  create: create,
  lobby: {
    messages: ['d.words'],                         // mensajes que se aceptan en el menú
    onJoin: function (api, slot, store) { /* al entrar un jugador */ },
    onMessage: function (api, slot, msg, store) { store.words = limpiar(msg.list); },
    badge: function (store) { return '2 palabras secretas'; }   // se ve en la tele junto al nombre
  }
};
```

## 3. La tele: `tv.js`

Las vistas son JavaScript normal del navegador, **ES2019** (la tele LG usa
Chromium 87). Se registran con `G2T.tv.register`:

```js
(function () {
  'use strict';
  var G2T = window.G2T;
  var host = null, view = null, meta = null;

  function render() { /* pinta meta en el DOM: ver el archivo completo */ }

  G2T.tv.register({
    id: 'ejemplo-reflejos',
    mount: function (h) {                  // una vez, al cargar la página
      host = h;
      view = document.createElement('section');
      view.id = 'vReflejos';
      view.className = 'view';             // vista de 1920x1080 que el hub escala a la pantalla
      view.innerHTML = '<div class="rx-big fit" id="rxBig">Preparados…</div>…';
      h.addView(view);
    },
    enter: function () { host.show(view, true); },              // el hub cambia a este juego
    leave: function () { host.show(view, false); meta = null; }, // vuelta al menú
    onHub: function () { render(); },                            // cambian los jugadores
    onMessage: function (msg) {                                   // mensajes del juego
      if (msg.t === 'rmeta') { meta = msg; render(); }
    }
  });
})();
```

Diseña siempre para **1920x1080**: el hub escala el escenario a la pantalla.

Otras funciones opcionales: `frame(t, dt)` (cada fotograma, para animaciones o
canvas), `layout(w, h)` (cambio de tamaño), `onEvent(ev)` (eventos `ev` del
servidor), `onKey(e, dir, ok)` (mando de la tele; devuelve `true` si lo has
usado), `onConnect()`, `debugInfo()`.

El objeto `host` de la tele:

| | |
|---|---|
| `host.addView(el)` | Añade tu vista al escenario de 1920x1080. |
| `host.addLayer(el)` | Capa a pantalla completa por debajo (p. ej. el canvas del Pong). |
| `host.show(el, sí/no)` · `host.setText(el, texto)` · `host.fit(el, max, min)` | Utilidades de DOM (`fit` encoge la letra hasta que cabe). |
| `host.playerName(i)` · `host.colors()` · `host.hub()` | Jugadores y colores. |
| `host.send(obj)` | Enviar al servidor (como `onMessage` con `who = -1`). |
| `host.sfx.go()`, `.correct()`, `.wrong()`, `.win()`, `.tick()`… · `host.beep(...)` | Sonidos. |
| `host.toast(texto)` · `host.confetti()` | Aviso y confeti. |
| `host.capDpr(anchoCss)` · `host.stageScale()` | Para dimensionar canvas sin pasarse (ver rendimiento). |
| `host.FX` | `true` con `?fx=1` (brillos caros activados). |

## 4. El móvil: `phone.js`

```js
G2T.phone.register({
  id: 'ejemplo-reflejos',
  mount: function (section, h) {           // section: tu pantalla, ya creada por el hub
    host = h;
    section.innerHTML =
      '<div class="bar"><div class="chip"><span class="dot"></span><span class="meName">Jugador</span></div>' +
      '<button class="mini ghost menuBtn" type="button">Menú</button></div>' +
      '<div id="rxPad"><div id="rxMsg">Espera…</div></div>';
    document.getElementById('rxPad').addEventListener('touchstart', function (e) {
      e.preventDefault();
      host.send({ t: 'r.tap' });           // touchstart: la respuesta más rápida
      host.vibrate(20);
    }, { passive: false });
  },
  reset: function () { meta = null; },     // el hub ha cambiado de pantalla
  render: render,                          // cambios en el hub (jugadores, etc.)
  onMessage: function (msg) { if (msg.t === 'rmeta') { meta = msg; render(); } }
});
```

- Un botón con la clase **`menuBtn`** ya pregunta «¿Volver al menú?» y avisa al
  servidor. Un elemento con la clase **`meName`** muestra el nombre del jugador.
- El color del jugador está en la variable CSS `--c` (úsala en tus estilos).
- `host.slot()` es tu hueco **empezando en 1** (como en los mensajes `rmeta`).

El objeto `host` del móvil: `send`, `slot`, `myName`, `myColor`, `colors`,
`hub`, `nameOf(slot)`, `otherName()`, `toast`, `askConfirm(texto, sí, fn)`,
`show(el, sí/no)` (con la clase `hidden`), `setText`, `vibrate`,
`confirmMenu`, y `app` (el contenedor, para capas propias como la de «Pausa»).

## 5. De 2 a 6 jugadores

La sala tiene 6 huecos y los jugadores entran y salen cuando quieren. Tu juego
dice en el manifiesto para cuántos es y se adapta a los que haya al empezar.
«Reflejos» es el ejemplo (de 2 a 6); «Pong» (2 a 4, por parejas con 3 o 4) y
«Dibuja y adivina» (2 en equipo, de 3 a 6 todos contra todos) son los casos
grandes.

**1. Declararlo.** `"minPlayers": 2, "maxPlayers": 6` en el manifiesto. El hub
se encarga del resto: el menú muestra «2 a 6 jugadores», pone la tarjeta en
gris con el motivo si no encaja, y si alguien la elige igualmente manda a la
tele y a todos los móviles `{ t: 'ev', k: 'need2' | 'toomany', text, min, max, n, … }`
con un texto ya listo para mostrar.

**2. Quién juega: `api.players()`, no `0…slots-1`.** Los huecos pueden tener
saltos (Ana en el 1, Carla en el 3 porque Berto se fue). Recorre siempre la
lista de ocupados y guarda los datos por hueco:

```js
function newMatch() {
  S.scores = new Array(api.slots).fill(0);              // por hueco (0…slots-1)
  // …
}
function buildMeta() {
  return {
    t: 'rmeta',
    players: api.players().map(function (i) { return i + 1; }),   // en los mensajes, desde 1
    scores: S.scores.slice(),
    // …
  };
}
```

Si tu juego admite **menos** jugadores que huecos hay ocupados por encima de su
máximo (el Pong, hasta 4, con alguien en el hueco 6), el hub **compacta** los
huecos antes de empezar: los jugadores bajan a los huecos libres y su móvil
recibe un `joined` nuevo (con su nuevo color). Si no hace falta, no mueve a
nadie: no des por hecho que los jugadores están en `0…n-1`.

**3. Decidir con los que hay al empezar.** Lee `api.players()` en `start()` (y
al volver a jugar), no en cada tick. Así, quien entra a mitad de partida mira
y juega en la siguiente. Dibuja elige ahí su modo (2: en equipo; 3 a 6: todos
contra todos) y el Pong sus palas.

**4. Pausa solo por los que juegan.** `api.allConnected()` mira a toda la sala;
si alguien solo está mirando, mejor `api.isConnected(i)` sobre tus jugadores.

**5. Alguien se va del todo: `onPlayerLeft(i)`.** Cuando un jugador pulsa
«Salir» o no vuelve en 30 s, el hub llama a `onPlayerLeft(i)` si quedan al
menos `minPlayers`. Devuelve `false` (o no la definas) para volver al menú,
como antes; devuelve cualquier otra cosa para seguir. La tele y los móviles
reciben `{ t: 'ev', k: 'left', name }`. En «Reflejos»:

```js
onPlayerLeft: function (i) {
  S.early = S.early.filter(function (s) { return s !== i; });
  S.scores[i] = 0;
  if (S.last && S.last.slot === i) S.last = null;
  dirty = true;
  return true;            // la partida sigue con los demás
}
```

Dibuja quita los turnos que le quedaban (si dibujaba, desvela la palabra y
pasa al siguiente); el Pong no la define (sin un jugador no hay equipo).

**6. La tele con 6.** El escenario mide 1920 px: 6 marcadores de 400 px no
caben. «Reflejos» estrecha las cajas cuando hay más de 4 (`.rx-scores.many`,
6 × 296 px) y ajusta los nombres con `host.fit()`. Nombres de hasta 12
caracteres: usa siempre la clase `fit` + `host.fit(el, máx, mín)` en lo que
lleve nombres, y el color de cada uno con `host.colors()[hueco - 1]`.

**7. El móvil.** `host.slot()` es tu hueco (desde 1), `host.nameOf(hueco)` el
nombre de otro, `host.myColor()` el tuyo (también en la variable CSS `--c`).
`host.otherName()` junta los nombres de todos los demás («Ana, Berto y Carla»).

Si quedan menos de `minPlayers`, el hub vuelve al menú y manda
`{ t: 'ev', k: 'menu', reason, text }` con el motivo ya escrito («Ana se ha ido
y «El Infiltrado» necesita al menos 3 jugadores…»).

**Información secreta.** Si tu juego reparte secretos (la palabra de Dibuja, la
carta de «El Infiltrado»), mándalos solo con `api.sendSlot` y procura que el
resto de mensajes sea igual para todos: «El Infiltrado» manda el mismo `imeta`
a la tele y a todos los móviles y una carta con los mismos campos y tamaño a
cada uno, y sus pruebas lo comprueban ronda a ronda.

**8. Probarlo con muchos.** `test/grupo.test.js` juega «Reflejos» con 6 móviles
falsos (`H_.phone(WS, nombre, cid)`) en pocas líneas: cópialo.

## 6. Probarlo

```bash
game-to-tv start
```

Abre `http://localhost:3000/` en una ventana grande (la «tele») y
`http://localhost:3000/m` en dos o más pestañas (los «móviles»; cada pestaña
es un jugador distinto). Las páginas se
leen del disco en cada petición: si cambias `tv.js` o `phone.js`, basta con
recargar. Si cambias `index.js`, reinicia el servidor.

Trucos: `?debug=1` en la tele muestra los FPS; la variable `REFLEJOS_DEBUG_SPEED=8`
acelera las esperas.

## 7. Escribir las pruebas

[`test/reflejos.test.js`](../test/reflejos.test.js) hace dos cosas, y te
sirven de plantilla:

1. **Prueba unitaria** con una `api` falsa y `random` fijo: simula ticks y
   toques, y comprueba fases, puntos y final.
2. **Prueba de integración**: arranca el servidor de verdad, conecta una tele y
   tres móviles falsos por WebSocket (`test/helpers`) y juega una partida. Con
   6 móviles, en [`test/grupo.test.js`](../test/grupo.test.js).

```bash
npm test               # todas las pruebas
node test/run.js reflejos
npm run check          # tu tv.js y phone.js deben ser ES2019, y tu index.js compatible con Node 12
npm run test:node12    # las pruebas con Node 12, como en la tele
```

## 8. Lista de comprobación

- [ ] `manifest.json` con `id` igual a la carpeta, `minPlayers`/`maxPlayers` correctos.
- [ ] Jugadores con `api.players()` (con saltos), elegidos al empezar; `onPlayerLeft`
      si la partida puede seguir sin alguien; la tele probada con el máximo.
- [ ] El servidor decide todo; los móviles solo envían intenciones.
- [ ] Un mensaje de estado completo, reenviado cada segundo, y `syncTv` /
      `onPlayerJoined` para los que se reconectan.
- [ ] Pausa si `api.allConnected()` es `false`.
- [ ] Nada secreto en los mensajes a la tele (la tele la ve todo el mundo).
- [ ] Vistas en ES2019 y servidor compatible con Node 12 (`npm run check`),
      textos en español.
- [ ] Si guardas archivos, comprueba antes que `api.galleryDir` no sea `null`.
- [ ] Rendimiento en la tele: nada de `shadowBlur` ni degradados grandes en cada
      fotograma; pinta lo estático una vez en un canvas aparte; usa
      `host.capDpr()` al dimensionar canvas (en webOS el `devicePixelRatio` es 2
      y un canvas de 3840x2160 baja a 8-9 FPS).
- [ ] Pruebas en `test/<juego>.test.js`.
