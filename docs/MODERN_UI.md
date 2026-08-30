# ParkingMartin-G · Modern UI v1

## Objetivo

Crear una experiencia operativa que se sienta como una aplicación móvil moderna dentro de Telegram, manteniendo la lógica de negocio estable.

La modernización no debe introducir pasos innecesarios. La prioridad sigue siendo completar operaciones rápidamente, con controles grandes, feedback inmediato y mínima carga cognitiva.

## Principios

1. **Telegram primero.** El chat es el lanzador rápido; las Mini Apps se usan cuando una interfaz rica aporta valor real.
2. **Una acción primaria por pantalla.** Evitar competir con varios botones equivalentes.
3. **Estado visible.** Matrícula, estado del vehículo y paso actual deben reconocerse de un vistazo.
4. **Feedback físico.** Usar `HapticFeedback` en confirmaciones, selección, advertencias y errores.
5. **Botones nativos cuando aportan valor.** Preferir `MainButton`, `SecondaryButton` y `BackButton` de Telegram en Mini Apps.
6. **Tema nativo.** Respetar automáticamente modo claro/oscuro y colores de Telegram.
7. **Safe areas.** Toda Mini App debe respetar `contentSafeAreaInset` y `safeAreaInset`.
8. **60 fps, sin espectáculo inútil.** Animaciones cortas y funcionales; respetar `prefers-reduced-motion`.
9. **No exponer nombres internos.** Nunca mostrar `park`, `lookup`, `retrieve`, IDs o estados técnicos al operario.
10. **El contexto no se pierde.** Abrir Maps, ampliar una foto o revisar datos no debe destruir la operación actual.

## Identidad visual

- Superficies redondeadas, radios grandes y separación clara.
- Tipografía del sistema para máxima velocidad y compatibilidad.
- Uso moderado del color de acento de Telegram.
- Verde: operación correcta / vehículo aparcado / verificación satisfactoria.
- Ámbar: atención / estado transitorio / precisión mejorable.
- Rojo: error real o acción destructiva.
- No codificar colores fijos para la estructura general: el tema de Telegram manda.

## GPS Pro

Objetivos de UX:

- mostrar precisión en metros como dato principal;
- traducirla a calidad humana: Excelente / Muy buena / Buena / Mejorable / Baja;
- conservar automáticamente la mejor lectura;
- feedback háptico cuando mejora la lectura;
- `MainButton`: **USAR ESTA UBICACIÓN**;
- `SecondaryButton`: **MEJORAR PRECISIÓN**;
- cierre automático 2 s después de confirmar, según comportamiento acordado;
- mostrar latitud/longitud como información secundaria, no como protagonista.

## Expediente 360º

Cabecera:

- matrícula grande;
- estado actual como badge;
- hora de aparcado y último cambio.

Ubicación:

- precisión y coordenadas;
- referencia textual;
- botón de navegación solo si `vehicle.status === parked`;
- si no está aparcado, ubicación marcada explícitamente como histórica.

Evidencias:

- agrupadas por día + etapa;
- más recientes primero;
- hora y operario visibles;
- fotografías ampliables dentro de la Mini App;
- documentación mediante URL firmada temporal.

Historial:

- timeline vertical;
- nombres humanos en español;
- más reciente primero;
- actor y hora visibles.

## Centro de operaciones · siguiente fase

El chat debe evolucionar hacia un lanzador muy compacto:

- acción principal contextual;
- acceso a **Centro de operaciones**;
- botones consistentes para Recogida, Aparcar, Buscar, Entrega y Consultar;
- sección administrativa solo para `owner/admin`.

No se migrarán todos los flujos a una Mini App de una sola vez. Primero se modernizan las pantallas con más valor visual y después se evalúa qué pasos del chat ganan realmente con UI rica.

## APIs modernas aprobadas

Telegram Mini Apps:

- ThemeParams / cambios de tema;
- MainButton;
- SecondaryButton;
- BackButton;
- HapticFeedback;
- safeAreaInset / contentSafeAreaInset;
- `openLink()` para navegación externa sin cerrar la Mini App.

Backend existente:

- Supabase Edge Functions;
- PostgreSQL;
- Supabase Storage privado;
- Google Cloud Vision solo para OCR al aparcar.

## Regla de compatibilidad

La rama `baseline/stable-logic-2026-08-31` es el punto de retorno estable.

La rama `feat/modern-bot-ui-v1` puede modificar presentación y UX. No debe cambiar estados de dominio, reglas de permisos, auditoría o comportamiento de negocio sin una decisión explícita independiente.