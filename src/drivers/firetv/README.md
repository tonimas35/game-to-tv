# Driver de Amazon Fire TV (pendiente)

Este driver **todavía no está implementado**. El módulo `index.js` existe para
que `game-to-tv tv add salon 192.168.1.60 --driver firetv` dé un mensaje claro
y para dejar escrito el plan.

**Mientras tanto** usa el driver `browser`: abre en el navegador **Silk** (o
Firefox) de la Fire TV la dirección que muestra `game-to-tv start`.

## Plan

Todo se haría con `adb` por la red, sin root:

1. **Preparar la Fire TV** (una sola vez):
   - Ajustes → Mi Fire TV → Acerca de → pulsar 7 veces sobre el nombre del
     dispositivo para que aparezcan las **Opciones para desarrolladores**.
   - Opciones para desarrolladores → **Depuración ADB: activada**.
   - Opciones para desarrolladores → **Apps de origen desconocido: activadas**.
   - Ajustes → Mi Fire TV → Acerca de → Red: apuntar la IP.

2. **Emparejar** (`pair`): `adb connect 192.168.1.60:5555`. La tele muestra
   «¿Permitir depuración USB?»: marcar «Permitir siempre» y aceptar. La clave
   la guarda el propio `adb` (`~/.android/adbkey`).

3. **Instalar** (`install`): una APK mínima (`apps/firetv-launcher/`) con una
   sola `Activity` a pantalla completa con un `WebView` que:
   - recibe la URL del servidor como recurso al construirla (igual que la app de
     LG) o como extra del `Intent`;
   - sondea `/qr.svg` y navega a la URL cuando el servidor responde;
   - pasa las teclas del mando (DPAD, OK, BACK) a la página como `keydown`;
   - mantiene la pantalla encendida (`FLAG_KEEP_SCREEN_ON`).
   Instalación: `adb install -r game-to-tv-launcher.apk`.
   Construirla sin Android Studio es lo difícil: probablemente con una APK
   precompilada publicada en las «releases» y la URL pasada por `Intent`.

4. **Abrir** (`launch`): `adb shell am start -n io.gametotv.launcher/.MainActivity --es url http://192.168.1.50:3000/`.

5. **Controlar** (`control`): `adb shell input keyevent KEYCODE_DPAD_UP`
   (`KEYCODE_DPAD_CENTER`, `KEYCODE_BACK`, `KEYCODE_HOME`…).

6. **Captura** (`screenshot`): `adb exec-out screencap -p > captura.png`.

7. **Rendimiento** (`perf`): `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`
   y el mismo método por CDP que usa el driver de webOS (`src/drivers/webos/cdp.js`).

8. **Descubrir** (`discover`): mDNS/SSDP no es fiable en Fire TV; se puede
   probar el puerto 5555 en la subred o leer la caché ARP (`arp -a`) y buscar
   el prefijo MAC de Amazon.

## Qué falta para empezar

- Decidir cómo se distribuye la APK (compilada en CI con Gradle).
- Probarlo en una Fire TV real (Fire TV Stick 4K o similar).
