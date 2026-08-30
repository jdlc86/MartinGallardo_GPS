# Plan de pruebas actual

## Objetivo

Validar el sistema vigente sin depender de múltiples personas reales ni reintroducir flujos antiguos.

## 1. Entrada Telegram y menús

Casos obligatorios:

- `/start` de operario activo -> menú base;
- `/start` de admin/owner -> mismo menú base;
- `OTRAS OPCIONES` operario -> sin administración;
- `OTRAS OPCIONES` admin/owner -> incluye `GESTIONAR OPERARIOS`;
- callback antiguo `menu:close` -> no deja pantalla muerta; vuelve a UI vigente;
- ningún flujo nuevo genera botón `CERRAR`;
- el webhook de producción apunta a `telegram-gateway`.

## 2. Solicitudes y permisos

Matriz mínima:

| Caso | Estado inicial | Acción | Resultado |
|---|---|---|---|
| desconocido | sin usuario | escribe | `pending` |
| pending | pendiente <72 h | escribe | sigue pending |
| pending vencido | expires_at pasado | job/trigger | `expired` |
| rejected | sin usuario | vuelve a escribir | nuevo `pending` |
| approved activo | usuario activo | escribe | acceso |
| approved bloqueado | active=false | escribe | sin acceso, no pending |
| alta operario | pending | aprobar | approved + active=true |
| alta admin | pending | aprobar admin | approved + admin activo |
| bloquear | approved activo | dar de baja | approved + active=false |
| reactivar | approved bloqueado | reactivar | approved + active=true |
| promover | operario activo | hacer admin | admin activo |
| degradar | admin activo | quitar admin | operario activo |
| modificar owner | owner | cualquier acción destructiva | rechazado |
| admin self-change | admin | cambiarse rol/estado | rechazado |

Invariante: ningún usuario existente en `telegram_users` puede quedar `pending/rejected/expired`.

## 3. Recogida aeropuerto

Probar:

- matrícula válida;
- fotos de estado requeridas;
- foto de matrícula guardada sin OCR;
- documentación obligatoria;
- cancelar en cada paso;
- evidencias vinculadas al vehículo/operario;
- finalizar solo con requisitos completos.

## 4. Aparcar + OCR

Casos:

- matrícula nueva;
- matrícula existente;
- foto OCR coincide;
- OCR detecta otra matrícula;
- OCR no puede leer;
- repetir foto;
- override y continuar;
- override genera auditoría;
- cancelar;
- Google Vision no disponible -> feedback controlado;
- retry de foto no debe duplicar evidencia/evento cuando se implemente dedupe.

OCR no debe ejecutarse en ninguna otra etapa.

## 5. GPS Mini App

Probar:

- captura de GPS;
- precisión disponible;
- precisión no disponible;
- usuario acepta ubicación;
- ubicación llega al backend;
- Mini App muestra confirmación;
- cierre tras ~2 s;
- regreso al chat;
- cancelación/reintento;
- sin flujo de sectores.

No inventar precisión cuando el dispositivo/Telegram no la informa.

## 6. Buscar vehículo

- matrícula `parked` -> resultado correcto;
- navegación visible solo para `parked` con coordenadas válidas;
- vehículo `retrieved/in_transit/requested` -> sin navegación;
- matrícula inexistente;
- GPS histórico puede mostrarse como histórico pero no como destino activo;
- evento de consulta auditado cuando corresponda.

## 7. Entrega aeropuerto

- vehículo válido;
- confirmar entrega;
- cambio de estado;
- historial intacto;
- no ejecutar OCR;
- doble confirmación no debe duplicar entrega.

## 8. Consultar vehículo

Probar expediente con:

- vehículo sin evidencias;
- múltiples días/etapas;
- fotos ordenadas de nuevas a antiguas;
- agrupación día + etapa;
- hora y operario visibles;
- URLs firmadas válidas;
- URL expirada;
- OCR y overrides;
- historial traducido a nombres operativos;
- botón Navegar solo si `parked`.

## 9. Estado conversacional

- sesión persistente entre invocaciones;
- sesión expirada;
- cancelar limpia/neutraliza estado;
- `/start` devuelve a UI consistente;
- no depender de memoria RAM de Edge Function.

## 10. Idempotencia

Simular el mismo `update_id` dos veces para operaciones con escritura:

- solicitud de acceso;
- aprobación/rechazo;
- foto;
- OCR override;
- aparcado;
- entrega.

Objetivo: máximo un efecto de dominio.

La deduplicación explícita por `update_id` sigue siendo deuda técnica y debe tener pruebas antes de declararse resuelta.

## 11. Seguridad

Automatizar/verificar:

- ningún secreto en GitHub;
- webhook rechaza secret incorrecto;
- usuario no admin no puede ejecutar callbacks admin;
- owner no puede modificarse;
- Storage no permite acceso público permanente;
- Mini Apps requieren contexto Telegram válido;
- service-role no aparece en HTML/JS cliente;
- `telegram_user_id` se obtiene de `from.id`;
- RLS activo en tablas expuestas.

### `plate_verifications`

Actualmente RLS está desactivado. Debe existir una prueba específica una vez definida la política y habilitado RLS.

## 12. Integridad de datos

Comprobar periódicamente:

- usuarios activos con solicitud distinta de approved = 0;
- usuarios bloqueados con solicitud pending = 0;
- más de un owner = 0;
- evidencias sin vehicle_id = 0;
- plate_verifications sin vehicle válido = 0;
- navegación ofrecida a vehículo no parked = 0.

## 13. Carga razonable

Dataset sintético aproximado:

- 150 vehículos/día;
- 30 días;
- múltiples eventos y evidencias.

Medir:

- búsqueda por matrícula;
- vehículos parked;
- historial de vehículo;
- expediente con evidencias;
- listados administrativos.

## 14. Smoke test de release

1. owner `/start`;
2. operario `/start`;
3. comparar menús base;
4. solicitud nueva -> aprobar/rechazar;
5. Recogida con vehículo TEST;
6. Aparcar con OCR;
7. GPS Mini App;
8. Buscar + navegación;
9. Consultar vehículo;
10. Entrega;
11. verificar auditoría y estados finales.

Usar datos TEST y no borrar auditoría necesaria.
