# Servidor de relevo (para jugar por internet)

## ¿Para qué sirve?
Dos celulares en redes distintas no pueden hablarse directo. Este programita corre en un
computador conectado a internet; los dos celulares se conectan **a él** y él les pasa los
mensajes. Solo empareja a dos jugadores con un **código de 4 letras** y reenvía lo que
manda uno al otro. No guarda nada ni sabe nada del juego.

**Solo una persona lo instala (tú).** Tu amigo solo escribe la dirección y el código.

## Lo más fácil: ponerlo en internet UNA vez y que todos jueguen con un código
1. Crea una cuenta gratis en https://github.com y sube la carpeta `servidor` a un repositorio nuevo (botón "Add file → Upload files", arrastras los archivos).
2. Crea una cuenta gratis en https://render.com → **New → Web Service** → conecta ese repositorio.
   Si te pide datos: Runtime **Node**, Build Command `echo ok`, Start Command `node relay.js`, plan **Free**.
3. Cuando termine, Render te muestra una dirección como `https://hornos-relevo.onrender.com`.
4. Abre el archivo `config_servidor.gd` del juego y pon esa dirección: `const URL := "wss://hornos-relevo.onrender.com"` (con `wss://` en vez de `https://`).
5. Exporta el juego otra vez (APK o web). **Listo: nadie tiene que escribir direcciones.** El que crea la partida recibe un código de 4 letras, el amigo lo escribe en "Unirse con un código".
   (Los pasos de Render pueden cambiar de nombre; si algo no coincide, busca "Web Service Node" en su documentación.)

## Probarlo en tu computador (2 minutos)
1. Instala Node.js (gratis, versión 18 o más): https://nodejs.org
2. En una terminal, dentro de esta carpeta `servidor`:  `node relay.js`
   (no necesita `npm install`: no usa librerías externas).
3. En el navegador abre http://localhost:8080 → debe decir "activo".
4. En el juego (menú) elige **Conexión: Internet** y escribe `ws://127.0.0.1:8080`.
   Con dos ventanas del juego (ver el LEEME principal) crea una partida en una y únete con el código en la otra.

## Ponerlo en internet de verdad (gratis)
Necesitas una dirección pública. Opciones gratuitas (los planes y límites cambian, revisa su página):

**Opción A: un servicio de hosting con Node (ej. Render, Railway, Fly.io).**
Sube esta carpeta `servidor` a un repositorio de GitHub, crea un "Web Service" de Node en el
servicio, con comando de inicio `node relay.js`. Te darán una dirección tipo
`https://mi-juego.onrender.com`. En el juego escribe esa dirección (sirve con o sin `https://`).
Los planes gratis suelen "dormirse" si nadie los usa: la primera conexión puede tardar
hasta un minuto en despertar (el juego espera hasta 60 s).

**Opción B: desde tu propio computador, con un túnel.**
Con el servidor corriendo (`node relay.js`), un túnel como Cloudflare Tunnel
(`cloudflared tunnel --url http://localhost:8080`) te da una dirección pública temporal tipo
`https://algo-aleatorio.trycloudflare.com`. Tu computador debe quedar encendido mientras juegan,
y la dirección cambia cada vez.

En ambos casos, en el juego se escribe la dirección en el campo que aparece al elegir
**Conexión: Internet**. Los dos jugadores deben escribir la **misma** dirección.

## Cosas a saber
- La conexión va por TCP (WebSocket): si el internet de alguno es malo, se notarán pequeños
  tirones. Para jugar bien, lo ideal es un servidor cercano a los jugadores.
- Límites de seguridad básicos: máximo 500 salas, una sala sin segundo jugador se borra a los 10 min.
- Si te quedas sin servidor, el modo "Misma wifi" sigue funcionando sin nada de esto.
