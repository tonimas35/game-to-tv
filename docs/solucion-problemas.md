# Solución de problemas

Lo primero, siempre:

```bash
game-to-tv doctor
```

Revisa Node, el puerto, la IP, el cortafuegos de Windows, `ares-cli` y las
teles configuradas (en las LG, también si el servidor de dentro de la tele
responde), **sin cambiar nada**, y dice qué hacer. Para una tele LG en modo
tele: `game-to-tv tv status salon`.

## La tele o los móviles no conectan con el PC

### Cortafuegos de Windows

Es la causa más habitual. Dos trampas que encontramos en un PC real:

1. **La red tiene el perfil «Pública»**: Windows bloquea todas las conexiones
   entrantes. Las redes de casa deberían ser «Privadas».
2. **Reglas de bloqueo de «Node.js JavaScript Runtime»**: si alguna vez
   alguien pulsó «Cancelar» en el aviso del cortafuegos, Windows crea reglas que
   **bloquean** Node en ese perfil. Las reglas de bloqueo ganan a las de
   permitir.

`game-to-tv doctor` lo detecta y te da los comandos exactos. Son estos (en
**PowerShell como administrador**; cambia «Wi-Fi» por el nombre de tu red y
3000 por tu puerto):

```powershell
# 1) Red de casa como Privada
Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private

# 2) Quitar las reglas que BLOQUEAN a Node.js
Get-NetFirewallRule -Direction Inbound | Where-Object { $_.DisplayName -like "*Node.js*" -and $_.Action -eq "Block" } | Remove-NetFirewallRule

# 3) Permitir solo el puerto del juego y solo desde la red de casa
New-NetFirewallRule -DisplayName "game-to-tv (TCP 3000)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -RemoteAddress LocalSubnet -Profile Private
```

Para comprobarlo desde el móvil: abre `http://IP-DEL-PC:3000/info` en su
navegador. Si responde, el cortafuegos ya no molesta.


> **`doctor` dice que no puede leer las reglas.** En algunos Windows,
> `Get-NetFirewallRule` no devuelve ninguna regla si PowerShell no se abre
> como administrador. `doctor` lo detecta (Windows siempre tiene decenas de
> reglas) y te avisa en vez de darte un falso error. Si la tele conecta, no
> tienes que hacer nada.

### La IP del QR no es la buena

El PC puede tener varias redes (VPN, máquinas virtuales, WSL, Docker…).
`game-to-tv start` elige la más probable y muestra las demás. Si se equivoca:

```bash
game-to-tv start --host-ip 192.168.1.40
```

Ojo: la app de la tele LG lleva la dirección del servidor dentro. Si la IP del
PC cambia, reinstálala (`game-to-tv tv install salon`) o, mejor, reserva la IP
del PC en el router.

### Otros

- Todos los aparatos deben estar en la **misma red** (cuidado con las redes de
  invitados y con los «aislamientos de clientes» de algunos routers).
- **«Ya hay dos jugadores»**: el sitio de quien se fue se guarda 30 s; espera o
  pulsa «Salir» en el otro móvil. Para más jugadores: `--jugadores 4`.
- **El puerto está ocupado**: otro programa (o otro `game-to-tv`) lo usa.
  `game-to-tv start --port 3001`.


## `game-to-tv tv scan` no encuentra la tele

- Comprueba que la tele está **encendida** (en reposo se desconecta del Wi‑Fi).
- Si tu PC tiene **varias redes** (WSL, Hyper‑V, VirtualBox, VPN), las
  versiones antiguas enviaban la búsqueda por la red equivocada y nadie
  contestaba. Desde la 0.1.1 se busca por cada red del PC. Actualiza.
- Algunos routers filtran el *multicast* entre el Wi‑Fi y el cable. Si aun así
  no aparece, añádela a mano con su IP (la ves en la tele: Ajustes → General →
  Red): `game-to-tv tv add salon 192.168.1.50`.

## La app de la tele dice «No encuentro el servidor… reintentando»

Esto es el **modo pc** (el servidor está en el PC). La app sigue probando cada
3 s; en cuanto el servidor responda, entra sola.

- ¿Está `game-to-tv start` en marcha en el PC?
- ¿Es la dirección que aparece en pantalla la del PC? Si no, reinstala con
  `--server-url`.
- Revisa el cortafuegos (arriba).

## Modo tele (LG): el servidor de la tele no arranca

La app se queda en «Arrancando los juegos…» o dice «No se pudo arrancar el
servidor de la tele».

- **«Service does not exist»** o la app no está: la app se instaló en modo pc,
  con una versión anterior a la 0.2, o el modo desarrollador caducó (abajo).
  Reinstala: `game-to-tv tv install salon`.
- **«El puerto 8090 de la tele está ocupado»**: otra app usa ese puerto.
  Reinstala con otro: `game-to-tv tv install salon --puerto 8095` (nunca 3000
  ni 3001, que son de LG).
- **Se queda arrancando**: la primera vez tarda unos segundos. Si pasa de 15 s,
  la app reintenta 3 veces; pulsa **OK** para volver a probar. Mira el
  registro (abajo) y, si lo tienes, usa el servidor del PC con **▲** (solo si
  instalaste con `--server-url`).
- Comprueba desde el PC: `game-to-tv tv status salon` y `game-to-tv doctor`.

## Modo tele (LG): los móviles no llegan al puerto 8090

El QR de la tele apunta a `http://IP-DE-LA-TELE:8090/m`.

- Los móviles deben estar en **la misma red** que la tele (no en la red de
  invitados ni con datos móviles).
- Comprueba desde el PC: `game-to-tv tv status salon` (o abre
  `http://IP-DE-LA-TELE:8090/info` en un navegador). Si el PC llega y el móvil
  no, el problema es la red del móvil o el aislamiento de clientes del router
  («AP isolation»).
- Si la IP del QR no es la de la tele en tu red (por ejemplo, la tele está por
  cable y por Wi‑Fi a la vez), mira `tv status`: la tele prefiere el cable
  (`eth0`) y después el Wi‑Fi (`wlan0`). Desconecta la que no uses.
- Conviene reservar la IP de la tele en el router (DHCP estático). Si cambia, al
  volver a abrir la app el servidor se reinicia con la nueva.
- El servidor se apaga solo tras 15 min sin pantalla ni jugadores: abre la app
  otra vez («Juegos del Salón»).

## Modo tele (LG): ha caducado el modo desarrollador

Síntomas: la app «Juegos del Salón» ha desaparecido de la tele, `tv status` no
responde y `ares-install` falla. La sesión de Developer Mode dura 50 h (999 h
si pulsas **Extend**) y, al caducar, webOS borra las apps instaladas en modo
desarrollador, servidor incluido.

1. En la tele, abre **Developer Mode**, inicia sesión y activa **Dev Mode
   Status** si está apagado (la tele se reinicia).
2. Pulsa **Extend** para tener 999 horas.
3. Desde el PC: `game-to-tv tv install salon`.

Pon un recordatorio para pulsar *Extend* de vez en cuando.

## Modo tele (LG): ver el registro del servidor de la tele

- Desde el PC: `game-to-tv tv status salon --logs`.
- Desde cualquier navegador de casa: `http://IP-DE-LA-TELE:8090/logs` (y
  `http://IP-DE-LA-TELE:8090/info` para el estado en JSON: versión, Node,
  carpeta de la galería, minutos sin uso).
- Si el servidor no llega a arrancar, el registro solo se ve en la tele: con
  `ares-inspect --device salon --service io.gametotv.launcher.service` (abre
  el inspector de Node del servicio), o con
  `ares-inspect --device salon --app io.gametotv.launcher` para la consola de la
  app.
- Desde la propia app, el método `luna://io.gametotv.launcher.service/logs`
  devuelve las mismas líneas.

## La tele va a tirones (pocos FPS)

```bash
game-to-tv tv perf salon        # FPS medidos en la propia tele
```

- Abre la tele con `?debug=1` para ver los FPS en pantalla.
- Prueba menos resolución en los canvas: `?res=960` (por defecto 1280 en webOS).
- En tus juegos: nada de `shadowBlur`, sombras CSS ni degradados grandes en
  cada fotograma; dibuja lo estático una vez en un canvas aparte; dimensiona
  los canvas con `host.capDpr()`. Ver [crear-un-juego.md](crear-un-juego.md).

## Salvapantallas

webOS enciende el salvapantallas si nadie toca el mando durante unos minutos,
aunque la imagen se mueva. Mientras hay un juego activo, la página intenta
evitarlo de tres formas: pidiéndoselo al sistema (si tiene acceso a
`PalmServiceBridge`), con un vídeo diminuto en bucle (`/keepalive.mp4`) y con un
cambio mínimo en la pantalla cada 20 s. En el menú no se evita, a propósito.
Si aun así salta, pulsa cualquier botón del mando.

## YouTube: «Error 153»

Los vídeos de YouTube incrustados (`<iframe>`) dan **error 153** dentro de apps
de webOS cargadas desde `file://`, porque no envían `Referer`. Las páginas del
servidor (`http://`) no tienen ese problema. Si algún día un juego necesita
vídeo, sírvelo desde el servidor en vez de incrustar YouTube en la app.

## La tele LG muestra el icono antiguo de la app

El lanzador de webOS guarda en caché los iconos. game-to-tv pone la versión en
el nombre del icono, así que al instalar una versión nueva se ve el nuevo. Si
reinstalas la misma versión, reinicia la tele.

## `ares-install` falla

- **Sesión caducada**: abre Developer Mode en la tele y pulsa *Extend* (ver
  [arriba](#modo-tele-lg-ha-caducado-el-modo-desarrollador)).
- **Falta la clave privada en el dispositivo** (el error típico tras
  `--getkey`):
  `ares-setup-device -m salon -i "privatekey=salon_webos" -i "passphrase=TU-PASSPHRASE"`.
- La tele debe estar **encendida**. Prueba: `ares-device --device salon --system-info`.

Más en [tele-lg.md](tele-lg.md).

## El navegador de la tele se queda en blanco o atascado

Pasa con el navegador de webOS cuando una página falló al cargar: por eso
existe la app lanzadora. Si usas el driver «browser» en otra tele, recarga la
página o reinicia el navegador.

## Modo ambiente sin fotos

Pon imágenes `.jpg`, `.png`, `.webp` o `.gif` en `~/.game-to-tv/ambiente` (o la
carpeta de `AMBIENTE_DIR` / `ambientDir` en la configuración). La lista se
relee cada 5 minutos. Zona horaria del reloj: `timezone` en la configuración o
`TZ_AMBIENTE` (por defecto `Europe/Madrid`).
