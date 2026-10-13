# Guía para teles LG (webOS)

Probado en una LG con **webOS 22** (motor del navegador: Chromium 87) a 60 FPS.
Debería funcionar en cualquier LG con webOS 4 o posterior.

Resumen:

```bash
game-to-tv tv scan                      # 1. encontrar la tele
game-to-tv tv add salon 192.168.1.50    # 2. darle un nombre
game-to-tv tv pair salon                # 3. emparejar (aceptar en la tele)
game-to-tv tv install salon             # 4. instalar la app (modo desarrollador)
game-to-tv start --abrir salon          # 5. ¡a jugar!
```

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

La app es mínima: espera a que el servidor responda y abre los juegos. Para
instalar apps propias, LG exige el **modo desarrollador**. Es gratis:

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
   game-to-tv tv install salon
   ```
   Por defecto, la app abrirá `http://<IP de este PC>:3000`. Si el servidor va a
   correr en otro PC o puerto: `--server-url http://192.168.1.40:3000`.

Solo crear el paquete (sin tele ni `ares-cli`):

```bash
game-to-tv tv ipk --server-url http://192.168.1.40:3000 --salida .
# o: game-to-tv tv install salon --solo-ipk
```

### La sesión de desarrollador caduca

La sesión dura **50 horas**. Al abrir la app Developer Mode y pulsar **Extend**
pasa a **999 horas**. Si caduca, las apps instaladas en modo desarrollador
**desaparecen** de la tele y hay que volver a instalarlas. Pon un recordatorio.

### El icono no cambia al actualizar

El lanzador de webOS guarda en caché el icono de una app instalada. Por eso
los iconos llevan la versión en el nombre (`icon-0.1.0.png`): al subir de
versión, la tele muestra el nuevo. Si reinstalas la misma versión, reinicia
la tele.

## 5. Abrir los juegos

```bash
game-to-tv start --abrir salon           # arranca y abre
game-to-tv tv open salon                 # abrir con el servidor ya arrancado
game-to-tv tv open salon --ruta /ambiente
```

También se puede abrir desde la lista de apps de la tele («Juegos del Salón»).

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
- **YouTube**: los vídeos de YouTube incrustados fallan con el **error 153**
  dentro de apps de webOS que se cargan desde `file://`, porque no hay
  `Referer`. La app lanzadora navega al servidor (`http://`), así que las páginas
  del servidor no tienen ese problema, pero un `<iframe>` de YouTube en la
  propia app sí lo tendría.
- `requiredACG: []` en `appinfo.json`: será obligatorio a partir de webOS TV 27.
- El salvapantallas salta aunque la pantalla se mueva: ver
  [solucion-problemas.md](solucion-problemas.md#salvapantallas).
