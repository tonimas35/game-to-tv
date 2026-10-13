# Guía para teles LG (webOS)

Probado en una LG con **webOS 22** (motor del navegador: Chromium 87; Node.js
12.21 para los servicios) a 60 FPS. Debería funcionar en cualquier LG con
webOS 4 o posterior.

Resumen:

```bash
game-to-tv tv scan                      # 1. encontrar la tele
game-to-tv tv add salon 192.168.1.50    # 2. darle un nombre
game-to-tv tv pair salon                # 3. emparejar (aceptar en la tele)
game-to-tv tv install salon             # 4. instalar la app (modo desarrollador)
game-to-tv tv open salon                # 5. ¡a jugar! (o ábrela con el mando)
```

Desde la versión 0.2 **el PC solo hace falta para instalar o actualizar la
app**: el servidor de los juegos va dentro de la tele (modo tele).

## Modo tele y modo pc

| | **Modo tele** (por defecto) | **Modo pc** |
|---|---|---|
| Dónde corre el servidor | Dentro de la tele, como servicio de la app (Node.js de la tele) | En el PC (`game-to-tv start`) |
| ¿Hace falta el PC para jugar? | No. Solo para instalar o actualizar (`tv install`) | Sí, encendido y con `game-to-tv start` |
| Dirección de los móviles (QR) | `http://IP-DE-LA-TELE:8090/m` | `http://IP-DEL-PC:3000/m` |
| Cortafuegos de Windows | No interviene | Hay que abrir el puerto 3000 (`doctor`) |
| Galería de dibujos | En la tele, si encuentra una carpeta donde escribir (`tv status`) | `~/.game-to-tv/galeria` del PC |
| Instalar | `game-to-tv tv install salon` | `game-to-tv tv install salon --modo pc [--server-url URL]` |

```
  MODO TELE                                     MODO PC
  ┌──────────── Tele LG ────────────┐           ┌── Tele LG ──┐      ┌──── PC ─────┐
  │ app «Juegos del Salón»          │           │ app lanza-  │ ───▶ │ game-to-tv  │
  │   │ luna://…launcher.service/   │           │ dora        │      │ start :3000 │
  │   ▼ start                       │           └─────────────┘      └─────────────┘
  │ servicio JS (Node 12)           │                                  ▲
  │   servidor de juegos :8090  ◀───┼── móviles (QR)        móviles ───┘
  └─────────────────────────────────┘
```

Cómo funciona el modo tele:

1. Al abrir la app, muestra «Arrancando los juegos…» y llama a su servicio
   (`luna://io.gametotv.launcher.service/start`) con `PalmServiceBridge`.
2. El servicio arranca el mismo servidor de siempre en el **puerto 8090**, con
   la IP de la tele en la red de casa (cable `eth0` o Wi‑Fi `wlan0`) para el QR.
3. La app espera a que `http://127.0.0.1:8090/qr.svg` responda (con reintentos
   cada vez más espaciados) y abre `http://127.0.0.1:8090/`.
4. La página de los juegos mantiene una suscripción `heartbeat` con el
   servicio. El servidor se apaga solo tras **15 minutos** sin pantalla ni
   jugadores (`--apagado MIN` al instalar) y webOS cierra el proceso.

Si el servicio falla, la app muestra el error y cómo arreglarlo. Si al instalar
le diste un servidor de PC de reserva (`tv install salon --server-url
http://192.168.1.40:3000`), con **▲** en el mando se pasa a él.

**Jugadores**: hasta 6 por defecto, como en modo pc (`--jugadores N` al
instalar, de 2 a 8; queda en `tv-service.json`).

**Puerto**: 8090 por defecto (`--puerto N` al instalar). **No uses 3000 ni
3001**: en la tele los ocupa el servicio de LG para segundas pantallas (SSAP).

### Lo que medimos en una tele de verdad (webOS 22)

- La tele trae **Node.js v12.21.0**. Los servicios JS del modo desarrollador
  corren con un usuario propio (uid 5728) y tienen `require('webos-service')`
  (no se empaqueta: se usa el de la tele). Todo el código del servidor está
  comprobado para Node 12 (`npm run check`, y `npm run test:node12` pasa todas
  las pruebas con Node 12).
- `http.createServer().listen(8090, '0.0.0.0')` funciona dentro del servicio:
  otro equipo de la red llega a `http://IP-DE-LA-TELE:8090` y la app, a
  `http://127.0.0.1:8090`.
- El servicio tarda unos **3 s** en arrancar en frío: por eso la app espera a
  la respuesta de `start` y luego sondea el servidor con reintentos.
- Con la actividad `keepAlive` y la suscripción `heartbeat`, el servidor siguió
  vivo **más de 6 minutos**, 3 de ellos sin ninguna petición, e **incluso con la
  app cerrada**: al volver a abrirla, entra al instante.

### El modo desarrollador caduca (importante en modo tele)

En modo tele la app y su servidor son apps del modo desarrollador: si la sesión
de Developer Mode caduca, **desaparecen de la tele** (con ellas, los juegos).
Abre de vez en cuando la app **Developer Mode** y pulsa **Extend** (la sesión
pasa a 999 horas). Si ya caducó: actívala de nuevo y reinstala desde el PC con
`game-to-tv tv install salon`. Más abajo: [La sesión de desarrollador
caduca](#la-sesión-de-desarrollador-caduca).

### Comprobarlo desde el PC

```bash
game-to-tv tv status salon            # ¿responde el servidor de la tele? versión, Node, galería…
game-to-tv tv status salon --logs     # y las últimas líneas de su registro
game-to-tv doctor                     # incluye una línea por cada tele LG
```

`tv status` pregunta directamente al servidor (`http://IP-DE-LA-TELE:8090/info`):
por SSAP no se puede leer la respuesta de un servicio `luna://` propio. El
registro también se ve en `http://IP-DE-LA-TELE:8090/logs` desde cualquier
navegador de casa.

## 1. Encontrar la tele

```bash
game-to-tv tv scan
```

Busca por SSDP (lo mismo que usan las apps de control remoto). Si no aparece:

- La tele debe estar **encendida** (no en reposo) y en la misma red que el PC.
- Algunos routers bloquean el multicast entre Wi‑Fi y cable. Mira la IP en la
  tele: *Configuración → General → Red → Conexión Wi‑Fi/cable → Configuración
  avanzada*, y añádela a mano.
- Conviene reservar esa IP en el router (DHCP estático) para que no cambie.

## 2 y 3. Añadir y emparejar

```bash
game-to-tv tv add salon 192.168.1.50
game-to-tv tv pair salon
```

La tele muestra un aviso: acéptalo con el mando (hay 60 s). La clave
(«client-key») queda en `~/.game-to-tv/config.json` y ya no volverá a
preguntar. Comprueba que funciona:

```bash
game-to-tv tv toast salon "¡Hola desde el PC!"
game-to-tv tv info salon
```

> Si alguna orden responde `401 insufficient permissions`, la tele no ha dado
> ese permiso al manifiesto. Vuelve a emparejar (`tv pair`); si persiste,
> abre un *issue* con el modelo y la versión de webOS.

## 4. Instalar la app lanzadora

La app arranca el servidor de la tele (modo tele) o espera al del PC (modo
pc) y abre los juegos. Para instalar apps propias, LG exige el **modo
desarrollador**. Es gratis:

1. **En el PC**: instala las herramientas de LG:
   ```bash
   npm install -g @webos-tools/cli
   ```
2. **Cuenta**: crea una cuenta en <https://webostv.developer.lge.com> (gratis).
3. **En la tele**: instala **Developer Mode** desde LG Content Store, ábrela e
   inicia sesión con esa cuenta.
4. Activa **Dev Mode Status** (la tele se reinicia). Vuelve a abrir la app y
   activa **Key Server**. Apunta la **passphrase** (6 caracteres).
5. **En el PC**, registra la tele en `ares-cli` (usa el mismo nombre que en
   game-to-tv):
   ```bash
   ares-setup-device -a salon -i "host=192.168.1.50" -i "port=9922" -i "username=prisoner"
   ares-novacom --device salon --getkey          # pide la passphrase
   ```
6. **El paso que suele fallar**: indica la clave privada y la passphrase en el
   dispositivo; sin esto, `ares-install` falla aunque `--getkey` haya ido bien:
   ```bash
   ares-setup-device -m salon -i "privatekey=salon_webos" -i "passphrase=TU-PASSPHRASE"
   ares-device --device salon --system-info      # comprobación
   ```
7. Instala:
   ```bash
   game-to-tv tv install salon                    # modo tele: servidor dentro de la tele
   game-to-tv tv install salon --modo pc          # modo pc: abrirá http://<IP de este PC>:3000
   game-to-tv tv install salon --modo pc --server-url http://192.168.1.40:3000
   ```
   En modo tele, el paquete lleva la app y un servicio con el servidor y sus
   dependencias (unos 200 KB). Se empaqueta con `ares-package` si está
   instalado (`--empaquetador js` usa el empaquetador propio).

Solo crear el paquete (sin tele ni `ares-cli`):

```bash
game-to-tv tv ipk --salida .                                         # modo tele
game-to-tv tv ipk --modo pc --server-url http://192.168.1.40:3000 --salida .
# o: game-to-tv tv install salon --solo-ipk
```

### La sesión de desarrollador caduca

La sesión dura **50 horas**. Al abrir la app Developer Mode y pulsar **Extend**
pasa a **999 horas**. Si caduca, las apps instaladas en modo desarrollador
**desaparecen** de la tele y hay que volver a instalarlas. Pon un recordatorio.
En modo tele esto afecta también al servidor: sin la app no hay juegos hasta
reinstalar con `game-to-tv tv install salon`.

### El icono no cambia al actualizar

El lanzador de webOS guarda en caché el icono de una app instalada. Por eso
los iconos llevan la versión en el nombre (`icon-0.1.0.png`): al subir de
versión, la tele muestra el nuevo. Si reinstalas la misma versión, reinicia
la tele.

## 5. Abrir los juegos

```bash
game-to-tv tv open salon                 # modo tele: la app arranca su servidor
game-to-tv tv open salon --ruta /ambiente
game-to-tv start --abrir salon           # modo pc: arranca el servidor del PC y abre la app
```

Lo normal en modo tele es abrirla desde la lista de apps de la tele («Juegos
del Salón») con el mando: no hace falta el PC.

**No hay forma de que la tele abra la app sola al encenderse**: webOS no lo
permite. Lo más cómodo es `game-to-tv tv open salon` desde el PC, o fijar la
app en los primeros puestos de la barra de inicio.

### El mando

- ◀ ▶ y **OK** en el menú; **Atrás** (código 461) para volver al menú desde un
  juego, con confirmación.
- La app declara `"disableBackHistoryAPI": true` para que **Atrás** llegue a la
  página en vez de cerrar la app.

## Utilidades

```bash
game-to-tv tv shot salon captura.jpg     # captura (las apps con DRM salen en negro)
game-to-tv tv key salon HOME             # botones: UP, DOWN, LEFT, RIGHT, ENTER, BACK, HOME…
game-to-tv tv perf salon                 # FPS reales en la tele
game-to-tv tv luna salon luna://com.webos.settingsservice/setSystemSettings '{"category":"sound","settings":{"soundMode":"aiSoundPlus"}}'
```

### Medir el rendimiento (`tv perf`)

Ejecuta `ares-inspect --device salon --app io.gametotv.launcher`, que abre un
punto de acceso de DevTools, y mide con `requestAnimationFrame` durante 4 s
(`--segundos N`). Muestra los FPS, el peor fotograma, el tamaño de la ventana,
el `devicePixelRatio` y el tamaño del canvas. Objetivo: **60 FPS**.

### Llamadas `luna://` (avanzado)

Las apps externas no pueden llamar a los servicios internos (`luna://`)
directamente. Truco: crear una alerta cuyo botón ejecuta la llamada y cerrarla
al instante (`createAlert` + `closeAlert`). Funciona, por ejemplo, para cambiar
el modo de sonido. No devuelve el resultado.

## Lo que aprendimos en una tele de verdad

- **`devicePixelRatio = 2`** con `innerWidth = 1920`: un canvas a pantalla
  completa tendría 3840x2160 píxeles y el Pong bajaba a **8-9 FPS**. Todos los
  canvas limitan su tamaño real a 1280 px de ancho en webOS (`?res=N` para
  cambiarlo). Con eso: 60 FPS.
- Nada de `shadowBlur` ni degradados grandes en cada fotograma: lo estático se
  pinta una vez en un canvas aparte. Los brillos caros solo con `?fx=1`.
- El navegador de la tele se quedaba atascado en una página que no cargó a la
  primera: por eso la app lanzadora.
- Los puertos 3000 y 3001 de la tele están ocupados por el servicio SSAP de LG:
  el servidor de dentro de la tele usa el 8090.
- **YouTube**: los vídeos de YouTube incrustados fallan con el **error 153**
  dentro de apps de webOS que se cargan desde `file://`, porque no hay
  `Referer`. La app lanzadora navega al servidor (`http://`), así que las páginas
  del servidor no tienen ese problema, pero un `<iframe>` de YouTube en la
  propia app sí lo tendría.
- `requiredACG: []` en `appinfo.json`: será obligatorio a partir de webOS TV 27.
- El salvapantallas salta aunque la pantalla se mueva: ver
  [solucion-problemas.md](solucion-problemas.md#salvapantallas).
