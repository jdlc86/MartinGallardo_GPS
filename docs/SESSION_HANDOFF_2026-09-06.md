# Session handoff — 2026-09-06

## Estado del repositorio

- Repositorio: `jdlc86/MartinGallardo_GPS`
- Rama de producción: `main`
- HEAD revisado al documentar: `b32ff1ab47fdf4fa4329afd0c4f9eb46df8470dc`
- Producto: ParkingMartin-G
- Versión/build visible: `1.4.0 / 2026.09.04.04`
- Service Worker actual: `pmg-shell-v68`
- Runtime de conectividad: `offline-runtime.js?v=6`

## Cambios consolidados desde el handoff anterior

### 1. Sesiones protegidas

Se completó el modelo de recuperación de flujo y caducidad:

- los flujos protegidos persisten contexto mínimo;
- tras reload/reopen se usa `resume` y se revalida backend;
- se avisa antes de caducar;
- al expirar se crea notificación persistente y Telegram;
- el botón Telegram de expiración vuelve a la entrada principal;
- `/start` puede enviar **Bienvenido a una nueva sesión de ParkingMartin-G** cuando existe una expiración reciente;
- una sesión caducada no debe mezclarse con la siguiente.

Se corrigió además el parseo/sintaxis del mensaje de nueva sesión en `telegram-gateway`.

### 2. Informes automáticos

Se corrigió el problema de informes de las 04:00, 13:00 y 20:00 con conteos siempre en cero.

La lógica actual:

- incluye todos los roles operativos válidos;
- incluye reubicaciones;
- conserva informes individuales;
- Root/Admin reciben el global según las reglas existentes;
- `performance_report_dispatches` sigue deduplicando.

### 3. Home lista/cuadrícula

Se añadió un único botón visual que alterna el layout:

- cuadrícula;
- lista.

La preferencia queda en `localStorage` con clave `pmg_home_layout_v1`. No cambia navegación ni autorización.

### 4. Conectividad

El problema “Sin Internet · operaciones en pausa” durante apertura con Internet real fue atacado en dos pasos y el HEAD contiene el endurecimiento final:

- la sonda estática se confirma con hasta dos intentos;
- el primer timeout aislado ya no basta para declarar offline;
- el segundo intento usa una pequeña espera y timeout más amplio;
- el health de Supabase sigue diferenciando backend caído de falta de Internet;
- `connectivity-ping.txt` se sirve network-only desde el Service Worker;
- Service Worker incrementado a `pmg-shell-v68`.

Estados esperados:

- `offline`: frontend estático no alcanzable;
- `backend_down`: frontend alcanzable, Supabase health no;
- `online`: ambos alcanzables.

## Cambios visuales vigentes

- navegación superior modernizada en pantallas normales;
- flecha atrás y Home minimalistas;
- cabecera sticky/translúcida;
- flujos protegidos mantienen navegación propia;
- Back físico Android se conserva nativo en pantallas normales.

## Equipo en vivo

El diseño vigente sigue siendo:

- solo se muestran compañeros que están compartiendo ubicación;
- dejar de compartir elimina la fila cuando Telegram entrega la edición de fin;
- `live_until` evita marcadores caducados;
- no se guarda trayectoria histórica;
- la pantalla usa reconciliación + Realtime, no polling periódico.

## Reglas que no deben romperse

- permisos ADMIN siempre revalidados en backend;
- Root protegido;
- operaciones protegidas ligadas a trabajador/Telegram/matrícula/vehículo/tarea cuando corresponda;
- una sesión antigua nunca puede contaminar otra;
- no borrar historia de negocio al limpiar estado técnico abortado;
- Buscar y Entrega solo navegan si existen coordenadas reales;
- ubicación manual debe mostrarse cuando no existe GPS;
- una persona que deja de compartir ubicación debe desaparecer del mapa;
- UI no muestra errores internos crudos;
- despliegues críticos requieren source revision/attestation/guard coherentes.

## Pruebas prioritarias siguientes

1. Conectividad: abrir desde Telegram con Internet real y comprobar que no aparece falso offline.
2. Repetir con caché previa, app reabierta y Service Worker ya instalado.
3. Cortar Internet real y confirmar `offline`.
4. Simular backend no disponible con Pages accesible y confirmar `backend_down`.
5. Restaurar y comprobar recuperación automática.
6. Verificar el siguiente informe real de rendimiento con actividad y confirmar conteos.
7. Completar la prueba de caducidad y decidir/restaurar explícitamente los tiempos productivos acordados.
8. Verificar lista/cuadrícula tras reapertura de Telegram.

## Commits recientes relevantes

- `b32ff1a` — harden connectivity classification
- `cb3ba9a` — home list-grid toggle
- `5ffbff3` — avoid false offline on Telegram startup
- `d621970` — correct performance report counts
- `caf0801` — parse new-session Telegram message
- `4e77eca` — complete protected-session expiry cycle
- `929599e` — modernize protected flow navigation
- `963f331` — resume protected flows after reload

## Documentos actualizados en este cierre

- `docs/ARCHITECTURE.md`
- `docs/TEST_PLAN.md`
- `docs/CURRENT_ROADMAP.md`
- `docs/STABLE_RELEASE.md`
- `docs/SESSION_HANDOFF_2026-09-06.md`
