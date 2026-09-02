# ParkingMartin-G
## Asistente IA de asignación — Implementación V1

**Continuación técnica de:**
- `docs/ParkingMartinG_Asistente_IA_Asignacion_Operarios.md`
- `docs/ParkingMartinG_Asistente_IA_Asignacion_Operarios_CONTINUACION.md`

Este documento fija los parámetros cerrados para V1 y registra la implementación inicial realizada el 2 de septiembre de 2026.

## 1. Parámetros cerrados de incertidumbre

V1 utiliza márgenes deterministas configurables; no se introduce todavía un modelo probabilístico complejo.

- Carretera: `10 %` sobre la duración estimada, con mínimo de `2 min`.
- Coordinación con compañero: `3 min` adicionales cuando exista una dependencia de recogida/traslado.
- Bus Tránsito T1/T2/T3/T4: `5 min` de acceso + espera conservadora máxima según frecuencia + tiempo de trayecto.
  - 06:00–22:00: espera máxima `5 min`.
  - 22:00–06:00: espera máxima `20 min`.
- T4↔T4S: `10 min` de acceso + tiempo de tren + espera variable/conservadora según frecuencia.
- Tiempo operativo por `pickup`/`delivery`: `10 min`.
- Objetivo de llegada: `5 min` antes.
- Retraso máximo: `pickup +5 min`; `delivery +10 min`.

Todos estos valores se almacenan en configuración y no deben dispersarse como constantes de negocio por el frontend.

## 2. TTL de Google Routes

- Trayectos necesarios dentro de las siguientes 24 h: TTL `2 h`.
- Trayectos de días posteriores dentro del horizonte: TTL `12 h`.
- Sin polling fijo.
- Antes de optimizar, el backend debe reutilizar caché vigente y refrescar solo datos caducados/necesarios.
- Google se usa como sensor de calibración por `origen × destino × franja`, no por reserva individual.

## 3. Formato de informe Telegram

Cada operario recibe texto cronológico y accionable. Debe contener fecha/hora, tipo de operación, terminal, matrícula, cliente, hora de salida recomendada, medio de desplazamiento y dependencias.

Ejemplo conceptual:

```text
📅 Plan operativo · Miércoles 3
07:35 · Salir del Parking
08:00 · RECOGIDA · T4 · 1234ABC · Juan Pérez
08:10 · Fin operación
08:15 · Lanzadera T4 → T1
08:30 · Llegada prevista T1
08:45 · ENTREGA · T1 · 5678DEF · Ana Ruiz

👥 Recoger compañero: Pedro en T1 a las 09:00 → Parking
⚠️ Mantener el itinerario indicado para cumplir las siguientes operaciones.
```

Si no existe traslado de compañero, esa sección no aparece. El Admin recibe todos los informes individuales.

## 4. Permisos y cambio de titular

Se reutiliza exclusivamente el mecanismo existente de Gestión de Reservas:

- `parking_booking_write_state`
- `writer_epoch`
- `parking_booking_request_write`
- `parking_booking_offer_transfer`
- `parking_booking_respond_permission`
- `parking_booking_require_writer`

Mensaje cuando el usuario no tiene escritura:

> **No tienes permisos para usar el Asistente IA de asignación. Solicita acceso de lectura/escritura.**

La solicitud usa el mismo workflow actual; no existe un sistema de permisos paralelo.

Si cambia el titular de Lectura/Escritura durante una sesión IA activa, las propuestas pendientes del anterior titular se invalidan y la sesión debe reiniciarse. Se generan avisos de cierre para el anterior titular y disponibilidad para el nuevo titular cuando corresponde.

## 5. Asignaciones manuales

Las asignaciones manuales son **inmutables para el solver**.

- El Admin puede fijarlas antes de lanzar la IA.
- El solver nunca propone cambiarlas.
- Una reoptimización tampoco las toca.
- Ocupan tiempo/posición en el itinerario y condicionan la solución restante.
- En la confirmación se comprueba que siguen intactas; si cambiaron, el plan se invalida.

## 6. Horizonte

- Predeterminado: `7 días`.
- Configurable entre 1 y 31 días en V1.

## 7. Implementación inicial en Supabase

Migraciones añadidas:

- `ai_dispatch_planning_v1`
- `ai_dispatch_session_handover_v1`

Tablas nuevas:

- `ai_dispatch_config`
- `ai_dispatch_plans`
- `ai_dispatch_route_matrix`
- `ai_dispatch_sessions`

Las tablas nuevas tienen RLS habilitado y acceso directo revocado a `anon` y `authenticated`; el acceso se realiza desde backend controlado.

Edge Function nueva:

- `reservation-ai-planner`
- versión desplegada durante esta implementación: **v2**

Acciones iniciales:

- `status`
- `optimize`
- `confirm`
- `reject`

La confirmación **no escribe directamente mediante una ruta paralela**: reutiliza `reservation-task-api` para materializar las asignaciones y conservar su historial/notificaciones/concurrencia.

## 8. Mini App

Archivo nuevo:

- `docs/preview-modern/ai-dispatch.html`

`task-dispatch-runtime.js` inserta el botón `✨ IA` en la pantalla existente de Asignación de tareas sin sustituir el flujo manual.

La pantalla IA permite:

- comprobar el permiso actual;
- solicitar Lectura/Escritura usando el mecanismo existente;
- elegir horizonte;
- generar propuesta;
- revisar todos los informes por operario;
- confirmar de una vez;
- rechazar;
- solicitar una nueva optimización.

## 9. Estado del motor V1

La primera versión desplegada del backend usa un motor determinista de planificación (`deterministic_v1`) para poder integrar y probar de extremo a extremo permisos, propuestas, inmutabilidad manual, concurrencia, informes y confirmación.

La arquitectura prevista sigue separando el motor determinista de la capa conversacional. La sustitución/evolución hacia OR-Tools/CP-SAT debe hacerse detrás del mismo contrato de propuesta para no alterar el workflow de la Mini App.

## 10. Pendientes técnicos explícitos

Antes de considerar cerrada la optimización logística avanzada faltan:

1. Resolver/verificar coordenadas o Place IDs exactos de Parking/T1/T2/T3/T4/T4S.
2. Conectar el refresco real de `ai_dispatch_route_matrix` con Google Routes y su clave habilitada para Routes API.
3. Incorporar al motor la optimización explícita de recogida/traslado de un compañero (máximo uno), no solo su estructura de informe/regla.
4. Evolucionar el motor determinista inicial a OR-Tools/CP-SAT o servicio equivalente manteniendo el mismo contrato.
5. Añadir la capa conversacional IA para instrucciones de reoptimización, siempre revalidando `writer_epoch` en cada mensaje.

Estos pendientes no modifican el modelo de permisos, confirmación ni conservación de asignaciones manuales ya implementados.