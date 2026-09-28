# CarMeet API

REST para el catálogo y OAuth de Mercado Libre. Requiere Node >=22.18. La app envía su sesión de Supabase; la API la valida y consulta Mercado Libre con credenciales privadas. El inicio de sesión de los usuarios sigue en Supabase.

## Ejecutar

```sh
npm install
# Si todavía no existe .env, copiar .env.example a .env y completarlo.
npm run dev
```

Escucha en el puerto 3000 (configurable con PORT). `GET /api/health` permite comprobarla. `npm start` inicia sin watch y `npm test` ejecuta las pruebas sin contactar servicios reales.

## Autorizar Mercado Libre

Configurá MELI_CLIENT_ID, MELI_CLIENT_SECRET y MELI_REDIRECT_URI (también se acepta MELI_URL). La URI debe coincidir exactamente con la registrada en Mercado Libre. Activá offline_access para obtener refresh token; si la aplicación usa PKCE, configurá MELI_PKCE=true.

```sh
npm run meli:authorize
# Abrir la URL generada y autorizar. Si el retorno no apunta a esta API:
npm run meli:exchange -- --callback "URL_COMPLETA_DE_RETORNO"
npm run meli:status
```

Si la URI registrada apunta a `https://TU_API/api/meli/callback`, el intercambio se completa automáticamente al regresar. El state es obligatorio, de un solo uso y vence a los 10 minutos. En desarrollo podés usar una URL HTTPS que redirija a la API local o copiar el retorno completo y ejecutar exchange. No vuelvas a intercambiar un código que ya procesó el callback.

Los tokens se guardan atómicamente en `.env` o en MELI_ENV_FILE. La API renueva al necesitar el catálogo si el token venció, está próximo a vencer o Mercado Libre devuelve 401. Las consultas simultáneas comparten la renovación; hay bloqueo de archivo para evitar dos escrituras entre procesos. No hace falta ejecutar watch ni sincronizar secretos con Supabase.

## Rutas

| Método y ruta | Autorización | Resultado |
| --- | --- | --- |
| GET /api/health | Pública | Estado del servidor |
| POST /api/meli/catalog | Bearer de usuario Supabase | Array de valores del catálogo |
| POST /api/meli/authorize | Bearer API_ADMIN_TOKEN | URL de autorización |
| POST /api/meli/exchange | Bearer API_ADMIN_TOKEN | Recibe `{ "callback": "URL completa" }`, guarda tokens |
| GET /api/meli/callback | state de autorización pendiente | Completa OAuth |
| POST /api/meli/refresh | Bearer API_ADMIN_TOKEN | Renueva tokens |
| GET /api/meli/status | Bearer API_ADMIN_TOKEN | Disponibilidad y vencimiento, sin secretos |

El catálogo recibe `{ "attribute": "BRAND", "known": [] }`. MODEL requiere una marca; TRIM y VEHICLE_YEAR requieren marca y modelo: `known: [{ "id": "BRAND", "value_id": "123" }, { "id": "MODEL", "value_id": "456" }]`.

API_ADMIN_TOKEN es una clave aleatoria privada para administración. Nunca incluirla en la app. Las respuestas no devuelven access token, refresh token ni client secret de Mercado Libre.

## Hosting

Usá HTTPS, `npm start`, las variables de `.env.example` y un volumen persistente para MELI_ENV_FILE (por ejemplo `/data/meli.env`, con el directorio ya creado y escribible). Configurá SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY del mismo proyecto que usa la app; CORS_ORIGINS acepta los orígenes web separados por comas.

Esta implementación está pensada para una sola instancia de API con disco persistente. Para múltiples réplicas, migrar tokens y estado OAuth a una base de datos con bloqueo distribuido. Un filesystem efímero pierde las credenciales rotadas al reiniciar. Si un proceso termina abruptamente dejando `.meli-oauth.lock`, retirar ese archivo solamente después de comprobar que ningún proceso OAuth sigue activo.

Completá EXPO_PUBLIC_API_HOSTED_URL en la app con el dominio real. El dominio de producción no viene preconfigurado.
