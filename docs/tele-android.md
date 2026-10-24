# Guía para Android TV, Google TV y Fire TV

La app **«Juegos del Salón»** para Android lleva el servidor de los juegos
**dentro de la tele**, igual que el modo tele de LG: el PC solo hace falta para
instalarla. Sirve para teles con Android TV o Google TV (Philips, Sony, TCL,
Xiaomi…), para el Chromecast con Google TV y para las Fire TV de Amazon.

Resumen:

```bash
game-to-tv tv add salon 192.168.1.60 --driver android   # 1. la IP de la tele
game-to-tv tv pair salon                                # 2. aceptar «¿Permitir la depuración?» en la tele
game-to-tv tv install salon                             # 3. instala la app (o --apk ARCHIVO)
game-to-tv tv open salon                                # 4. ¡a jugar! (o ábrela con el mando)
```

Antes hay que activar la depuración en la tele ([paso 1](#1-activar-la-depuración-en-la-tele)).

```
  Móvil 1 ──┐               ┌───────────── Tele Android ─────────────┐
     …      ├── Wi‑Fi ────▶ │ app «Juegos del Salón» (WebView)       │
  Móvil 6 ──┘   (o cable)   │ + servidor dentro: Node.js, puerto 8090 │
                            └────────────────────────────────────────┘
  QR en la tele → http://IP-DE-LA-TELE:8090/m
```

## Qué hace falta

- Android 7 o posterior (Android TV 7+, Google TV, Fire OS 6+) con procesador
  ARM de 32 o 64 bits (todas las teles y Fire TV normales).
- Unos 100 MB libres para la app.
- Memoria: el servidor usa unos 50-80 MB y la página de los juegos otros
  150-250 MB. En teles con 1,5-2 GB de RAM conviene no tener otras apps
  pesadas abiertas.
- Un PC con `adb` (Android platform-tools) para instalarla. Ver
  [más abajo](#adb-en-el-pc).

## 1. Activar la depuración en la tele

`adb` es la herramienta oficial de Android para instalar apps desde un PC. La
tele solo la acepta con las **opciones para desarrolladores** activadas.

### Android TV (Philips, Sony, TCL, Hisense…)

1. **Ajustes → Preferencias del dispositivo → Información**.
2. Baja hasta **Compilación** y pulsa **OK** 7 veces seguidas. Sale «Ahora eres
   desarrollador».
3. Vuelve a **Preferencias del dispositivo**: ahora hay **Opciones para
   desarrolladores**. Entra y activa **Depuración USB** (en algunas teles
   también hay **Depuración por red** o **ADB por red**: actívala).
4. Apunta la IP de la tele: **Ajustes → Red e Internet** → tu red (cable o
   Wi‑Fi) → **Dirección IP**.

En las Philips el menú puede llamarse **Ajustes → Todos los ajustes → Ajustes
de Android** antes de llegar a **Preferencias del dispositivo**.

### Google TV (Chromecast con Google TV, teles con Google TV)

1. **Ajustes → Sistema → Información**.
2. Pulsa **OK** 7 veces sobre **Compilación del SO de Android TV**.
3. **Ajustes → Sistema → Opciones para desarrolladores**: activa **Depuración
   USB**.
4. La IP: **Ajustes → Red e Internet** → tu red.

Algunos Google TV recientes (Android 12-14) solo tienen **Depuración
inalámbrica**: actívala, entra y elige **Vincular dispositivo con código**. En
el PC: `adb pair IP:PUERTO CÓDIGO` (con el puerto y el código que muestra la
tele) y después `adb connect IP:PUERTO` con el puerto de la pantalla principal
de Depuración inalámbrica. Luego `game-to-tv tv add salon IP --driver android`
y edita en `~/.game-to-tv/config.json` `"adbPort": PUERTO` si no es 5555.

### Fire TV (Amazon)

1. **Ajustes → Mi Fire TV → Acerca de**. Pulsa **OK** 7 veces sobre el nombre
   del aparato (p. ej. «Fire TV Stick 4K»). Sale «Ya eres desarrollador».
2. **Ajustes → Mi Fire TV → Opciones para desarrolladores**: activa
   **Depuración ADB** y **Apps de origen desconocido** (o **Instalar apps
   desconocidas**).
3. La IP: **Ajustes → Mi Fire TV → Acerca de → Red**.

### La primera conexión

La primera vez que el PC se conecta, la tele muestra **«¿Permitir la
depuración USB?»** con la huella del PC. Marca **«Permitir siempre desde este
ordenador»** y pulsa **Aceptar**. `game-to-tv tv pair` espera 60 s a que lo
hagas. La clave la guarda el propio `adb` en `~/.android/adbkey`.

> Conviene reservar la IP de la tele en el router (DHCP estático): así `adb`
> la encuentra siempre en el mismo sitio.

## adb en el PC

- **Windows**: `winget install Google.PlatformTools`, o descarga
  [SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools)
  y descomprímelo en `%USERPROFILE%\.game-to-tv\platform-tools\`.
- **Mac**: `brew install android-platform-tools` (o el zip de arriba en
  `~/.game-to-tv/platform-tools/`).
- **Linux**: `sudo apt install adb` (o el zip).

game-to-tv busca `adb` en este orden: la variable `GAME_TO_TV_ADB` (ruta
completa), el `PATH`, `ANDROID_HOME`/`ANDROID_SDK_ROOT`,
`~/.game-to-tv/platform-tools/` y las carpetas habituales del SDK de Android.
`game-to-tv doctor` dice cuál usa.

En Windows, game-to-tv arranca primero el servidor de `adb` aparte (`adb
start-server`, sin ventanas ni tuberías) y luego ejecuta `adb` directamente,
sin pasar por `cmd` ni PowerShell. Si usas `adb` a mano desde una herramienta
que se queda colgada la primera vez, ejecuta antes `adb start-server`.

## 2. Instalar con game-to-tv

```bash
game-to-tv tv add salon 192.168.1.60 --driver android
game-to-tv tv pair salon
game-to-tv tv install salon
```

`tv install` pregunta a la tele su procesador (`getprop
ro.product.cpu.abilist`) e instala el APK que le toca con `adb install -r`:

| APK | Para |
|---|---|
| `juegos-del-salon-VERSIÓN-armeabi-v7a.apk` | Teles de 32 bits (la mayoría de teles y Fire TV Stick) |
| `juegos-del-salon-VERSIÓN-arm64-v8a.apk` | Aparatos de 64 bits (Fire TV Stick 4K Max, Chromecast con Google TV…) |
| `juegos-del-salon-VERSIÓN-universal.apk` | Cualquiera (pesa el doble) |

**¿De dónde sale el APK?** Lo compila GitHub Actions
([`.github/workflows/android.yml`](../.github/workflows/android.yml)) en cada
cambio; el artefacto se llama **`juegos-del-salon-android`**.

- Sin `--apk`, `tv install` descarga el último. GitHub solo deja descargar
  artefactos con sesión iniciada: inicia sesión una vez con la [GitHub
  CLI](https://cli.github.com) (`gh auth login`) o pon un token en la variable
  `GITHUB_TOKEN`.
- A mano: entra en *Actions → Android TV*, abre la última ejecución en verde y
  descarga **juegos-del-salon-android** (un `.zip`). Después:

  ```bash
  game-to-tv tv install salon --apk juegos-del-salon-android.zip   # vale el .zip,
  game-to-tv tv install salon --apk carpeta-con-los-apk            # la carpeta
  game-to-tv tv install salon --apk juegos-del-salon-0.7.0-armeabi-v7a.apk   # o un APK
  ```

Para actualizar, lo mismo: `tv install` otra vez. Los dibujos y los récords
guardados en la tele se conservan.

## 3. Instalar con adb a secas

Sin game-to-tv en el PC, con el APK ya descargado:

```bash
adb start-server
adb connect 192.168.1.60:5555                 # acepta el aviso en la tele la primera vez
adb shell getprop ro.product.cpu.abilist      # armeabi-v7a,armeabi → el APK armeabi-v7a
adb install -r juegos-del-salon-0.7.0-armeabi-v7a.apk
adb shell am start -n io.gametotv.android/.MainActivity
```

Otras órdenes útiles:

```bash
adb shell am start -n io.gametotv.android/.MainActivity --es path /ambiente   # modo ambiente
adb shell am force-stop io.gametotv.android    # cerrar la app y su servidor
adb logcat -s g2t g2t-node                     # registro de la app y del servidor
adb uninstall io.gametotv.android              # desinstalar (se pierden los dibujos)
```

### La firma

Android solo deja actualizar una app con otra firmada con **la misma clave**.
Por eso todos los APK se firman con `apps/android-tv/sideload.keystore`, que
está en el repositorio a propósito: **solo para instalar a mano por ADB; no es
una clave de tienda**. Si alguna vez instalas un APK firmado con otra clave,
`adb install -r` falla con `INSTALL_FAILED_UPDATE_INCOMPATIBLE`: desinstala
primero (`adb uninstall io.gametotv.android`).

## Sin ordenador: desde la propia tele

No hace falta depuración ni PC. Cada versión de `main` se publica, sin
iniciar sesión, en:

```
https://github.com/tonimas35/game-to-tv/raw/apk/tv.apk
```

(`tv.apk` es la versión de 32 bits, que funciona en casi todas las Android TV,
Google TV y Fire TV; también hay `tv-arm64.apk` y `tv-universal.apk`.)

1. Instala un navegador en la tele (en Android TV, por ejemplo **TV Bro**; en
   Fire TV, la app **Downloader** o **Amazon Silk**).
2. Abre esa dirección y descarga el archivo.
3. Ábrelo: la tele dirá que no puede instalar apps de esa fuente. Pulsa
   **Ajustes**, activa el permiso para ese navegador y vuelve atrás: sale el
   instalador. Pulsa **Instalar** y luego **Abrir**.
4. Desde entonces, «Juegos del Salón» está en la lista de apps de la tele.

Para actualizar, repite los pasos: la versión nueva se instala encima.

## 4. Jugar

Abre **«Juegos del Salón»** desde la pantalla de inicio de la tele (en Android
TV y Google TV sale en la fila de apps; en Fire TV, en *Tus apps y canales*), o
desde el PC con `game-to-tv tv open salon`.

1. La app muestra «Preparando los juegos…» mientras arranca el servidor (unos
   segundos; la primera vez tras instalar o actualizar, algo más).
2. Sale el menú con el QR. Los móviles lo escanean y se unen (hasta 6).
3. Se elige juego con el mando o desde un móvil.

### El mando

| Botón | Qué hace |
|---|---|
| ◀ ▶ ▲ ▼ | Moverse por el menú y por los juegos que usan el mando |
| OK | Elegir |
| Atrás | Lo mismo que «Atrás» en LG: cierra una sección o pregunta si volver al menú. En el menú principal, **dos veces seguidas** (en 2 s) sale de la app |
| ⏯ Play/Pausa | Como OK |
| ⏹ Stop | Como Atrás (sin salir de la app) |
| ⏪ ⏩ | Como ◀ ▶ |
| Canal +/− | Como ▲ ▼ |

## Cómo funciona

- La app tiene dos procesos: la **pantalla** (un `WebView` a pantalla completa
  que abre `http://127.0.0.1:8090/`) y el **servidor** (`:node`), un servicio
  en primer plano con Node.js 18 de [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile)
  que ejecuta el mismo servidor que el modo tele de LG
  (`src/tv-service/android.js` sobre `src/tv-service/core.js`).
- Puerto **8090**, modo `tele`, 6 jugadores. La IP del QR la calcula la app
  con `ConnectivityManager` (primero el cable, luego el Wi‑Fi), no con
  `os.networkInterfaces()`, que en Android no es fiable. Si la IP de la tele
  cambia, al abrir la app se reinicia el servidor para que el QR sea el bueno.
- Los dibujos de «Dibuja y adivina» (`http://IP-DE-LA-TELE:8090/galeria`) y
  los récords de «2048» van en la carpeta privada de la app (`files/datos/`):
  se conservan al actualizar y se borran al desinstalar. El modo ambiente
  (`tv open salon --ruta /ambiente`) funciona, pero sin fotos propias: esa
  carpeta no se puede llenar desde fuera de la app.
- **Apagado**: al salir de la app (Atrás dos veces, botón Inicio o cambiar de
  entrada), la página se descarga. Si en **15 minutos** no hay ninguna
  pantalla ni jugador conectado, el servidor se apaga y su proceso termina. Al
  volver a abrir la app se arranca otro; si sigue encendido, se reutiliza al
  instante.
- Node solo puede arrancar una vez por proceso: por eso el servidor vive en su
  propio proceso y la app lo termina y lo vuelve a arrancar cuando hace falta
  (por ejemplo, tras un error, con OK en la pantalla del error).

## Comprobarlo desde el PC

```bash
game-to-tv tv status salon          # ¿responde el servidor de la tele? versión, Android, memoria…
game-to-tv tv status salon --logs   # y su registro (también en http://IP-DE-LA-TELE:8090/logs)
game-to-tv tv info salon            # modelo, Android, procesador, memoria libre, versión de la app
game-to-tv tv shot salon            # captura de pantalla (PNG)
game-to-tv tv key salon BACK        # botones: UP, DOWN, LEFT, RIGHT, ENTER, BACK, HOME, PLAY…
game-to-tv tv perf salon            # FPS reales de la página (DevTools del WebView)
game-to-tv doctor                   # adb, puerto 5555 y servidor de cada tele Android
```

## Límites

- **La tele tiene que estar encendida con la app abierta** para que los móviles
  se unan y se vea el juego. No hay forma de que arranque sola al encender la
  tele; lo más cómodo es fijarla en la fila de favoritos o usar `game-to-tv tv
  open salon`.
- Los móviles tienen que llegar a la IP de la tele: misma red de casa (la tele
  puede ir por cable y los móviles por Wi‑Fi), pero no una red de invitados ni
  un Wi‑Fi con «aislamiento de clientes».
- Si la tele va justa de memoria, Android puede cerrar la página o el servidor.
  La app recarga la página sola; si el servidor se cae, al volver a abrir la
  app arranca otro. Cierra otras apps pesadas si pasa a menudo.
- Algunas teles desactivan la depuración al actualizar el sistema: si `tv
  pair` deja de conectar, revisa las opciones para desarrolladores.
- El APK no está en ninguna tienda: se instala a mano (adb).

## Solución de problemas

| Síntoma | Qué hacer |
|---|---|
| `tv pair`: «No puedo conectar … por adb» | ¿Tele encendida y en la misma red? ¿Depuración USB / por red / ADB activada? Algunas Android TV solo abren el puerto 5555 tras conectarlas una vez por USB y ejecutar `adb tcpip 5555`. |
| «no ha autorizado todavía a este PC» | Acepta el aviso en la tele con «Permitir siempre». Si no sale: Opciones para desarrolladores → **Revocar autorizaciones de depuración USB** y repite. |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | La app instalada tiene otra firma: `adb uninstall io.gametotv.android` y vuelve a instalar. |
| `INSTALL_FAILED_INSUFFICIENT_STORAGE` | Libera espacio en la tele (Ajustes → Almacenamiento). |
| La app se queda en «Preparando los juegos…» y da error | OK para reintentar. Desde el PC: `adb logcat -s g2t g2t-node`. Si dice que el puerto 8090 está ocupado, otra app lo usa: reinicia la tele. |
| Los móviles no abren el QR | Comprueba con `game-to-tv tv status salon` la IP que usa (`Móviles (QR)`). Desde un móvil, abre `http://IP-DE-LA-TELE:8090/m` a mano. Revisa que no estén en una red de invitados. |
| Va a tirones | `game-to-tv tv perf salon`. Los canvas ya van limitados a 1280 px de ancho; cierra otras apps. |
