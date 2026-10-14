# Juegos del Salón: guía para la familia

Juegos para todos en la tele del salón: la tele es la pantalla y los móviles son
los mandos. No hay que instalar nada en los móviles.

## Qué hace falta

- Un **ordenador** (Windows 10 u 11, o un Mac) conectado al Wi‑Fi de casa.
- Los **móviles**, conectados a **ese mismo Wi‑Fi** (no a la red de invitados).
- Si se puede, un **cable HDMI** para conectar el ordenador a la tele.

## 1. Abrir Juegos del Salón

**En Windows**, haz doble clic en `Juegos-del-Salon-Windows.bat`.

- Si sale «Windows protegió su PC», pulsa **Más información** y luego
  **Ejecutar de todas formas**. Si sale «¿Desea ejecutar este archivo?», pulsa
  **Ejecutar**.
- Se abre una ventana negra. La primera vez tarda unos minutos, porque
  descarga lo que hace falta.
- Si te pregunta si tu red de casa puede ser «Privada», pulsa **Enter**: es lo
  recomendado.
- Luego Windows pregunta «¿Quieres permitir que esta aplicación haga cambios en
  el dispositivo?» (Windows PowerShell). Pulsa **Sí**: así los móviles podrán
  conectarse.
- Si alguna vez sale un aviso del Firewall de Windows sobre «Node.js», pulsa
  **Permitir acceso**, nunca «Cancelar».
- La próxima vez, abre el icono **Juegos del Salón** del escritorio.

**En un Mac**, usa `Juegos-del-Salon-Mac.command`. La primera vez, haz **clic
derecho** (o Control + clic) sobre él y elige **Abrir** y otra vez **Abrir**.
Si no te deja: intenta abrirlo, cierra el aviso y ve a *Ajustes del Sistema >
Privacidad y seguridad*. Abajo del todo, pulsa **Abrir igualmente**. Si el Mac
pregunta si «node» puede aceptar conexiones entrantes, pulsa **Permitir**.

## 2. Ver los juegos en la tele

- **Con el cable HDMI (lo mejor):** conecta el ordenador a la tele. En el mando
  de la Samsung, pulsa **Source** (Fuente) y elige la entrada HDMI. Si tu mando
  no tiene ese botón, pulsa el de la casita y busca «Fuentes». Los juegos se
  abren solos a pantalla completa. Si en la tele ves el escritorio y no los
  juegos, en Windows pulsa la tecla **Windows + P** y elige **Duplicar**.
- **Sin cable:** en la tele Samsung, abre la app **Internet** y escribe la
  dirección que sale en la ventana del ordenador, algo como
  `http://192.168.1.40:3000/`.

**Mientras jugáis, no cierres la ventana del ordenador.** Para terminar,
ciérrala. Para salir de la pantalla completa, pulsa **F11**.

## 3. Unirse con los móviles

Cada uno escanea con la cámara del móvil el código QR de la tele, escribe su
nombre y pulsa **Unirse**. El juego se elige con el mando de la tele o desde
cualquier móvil.

| Juego | Jugadores |
|---|---|
| Dibuja y adivina | de 2 a 6 |
| Pong | de 2 a 4 |
| Reflejos | de 2 a 6 |
| El Infiltrado | de 3 a 6 (con 2 no se puede) |

## Si un móvil no se conecta

1. Mira que el móvil esté conectado **al mismo Wi‑Fi** que el ordenador.
2. Cierra la ventana del ordenador y vuelve a abrir Juegos del Salón. Si
   Windows pregunta si permites cambios, pulsa **Sí**.
3. Prueba a escribir en el navegador del móvil la dirección de la ventana
   del ordenador, terminada en `/m` (por ejemplo, `http://192.168.1.40:3000/m`).
4. Si sigue sin funcionar, haz una foto de la ventana del ordenador y
   envíasela a quien te pasó el archivo.
