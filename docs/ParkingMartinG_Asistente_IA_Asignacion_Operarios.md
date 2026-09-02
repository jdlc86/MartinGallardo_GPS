# ParkingMartin-G

## Diseño funcional y técnico del Asistente IA para asignación eficiente de operarios

Documento de arquitectura y requisitos · Septiembre 2026

## 1. Objetivo

Incorporar en Gestión de Reservas un botón de “Asistente IA” que ayude a Root/Admin a distribuir de forma eficiente las tareas de recogida y entrega entre los operarios. El sistema debe respetar restricciones duras, experiencia, disponibilidad, carga de trabajo y tiempos reales de desplazamiento. La IA debe conversar con el administrador, pedir únicamente la información que realmente falte y explicar la propuesta. La asignación no se ejecutará de forma silenciosa: el resultado será una propuesta que deberá pasar por los controles de permisos y concurrencia existentes.

## 2. Principio de arquitectura

No se recomienda que un LLM decida por sí solo el reparto. La solución se divide en dos capas: un motor de optimización determinista calcula una solución factible/óptima y la IA actúa como interfaz conversacional, interpreta requisitos administrativos, solicita datos faltantes y explica el resultado.

**Datos operativos + reglas + tiempos → Motor de optimización → Propuesta → IA/Chat → Confirmación Admin → API de asignación**

## 3. Variables y restricciones del optimizador

- **Tareas independientes:** Cada reserva genera pickup y delivery independientes. Pueden asignarse a personas distintas.
- **Horario:** La fecha/hora de cada tarea y el margen operativo deben respetarse.
- **Operarios activos:** Un operario inactivo queda excluido automáticamente y no debe aparecer como candidato.
- **Experiencia:** Cada operario se clasifica como BAJO, MEDIO o EXPERTO.
- **Gama alta:** RESTRICCIÓN DURA: un vehículo clasificado como GAMA_ALTA solo puede ser asignado a un operario EXPERTO. La optimización no puede relajar esta regla.
- **Carga de trabajo:** Debe evitarse la concentración innecesaria de tareas en un único operario y buscar un reparto razonablemente equilibrado.
- **Desplazamientos:** Se consideran los tiempos Parking↔Terminales y Terminal↔Terminal, además del tiempo propio de cada operación.
- **Encadenamiento:** Se favorecen secuencias eficientes, por ejemplo terminar en T4 y realizar otra operación cercana en T4 sin regresar innecesariamente al parking.
- **Traslado conjunto:** El modelo futuro debe contemplar que varios operarios puedan desplazarse juntos en un vehículo, reduciendo movimientos de lanzadera.
- **Reoptimización:** Ante retrasos, nuevas reservas, desactivaciones o cambios operativos, se recalcula únicamente lo que todavía puede modificarse, preservando tareas ya iniciadas/completadas.

## 4. Experiencia y clasificación de vehículos

La experiencia es información persistente del trabajador.

| Operario | experience_level |
| --- | --- |
| Nivel bajo | LOW / BAJO |
| Nivel medio | MEDIUM / MEDIO |
| Experto | EXPERT / EXPERTO |

Para vehículos se propone separar la clasificación del nombre de la marca: NORMAL o GAMA_ALTA. Si un vehículo es GAMA_ALTA, EXPERTO es obligatorio. Si la clasificación necesaria no existe, el asistente debe forzar al Admin a clasificarlo antes de usarlo en una asignación automática.

No conviene inferir de forma irrevocable “Maserati = gama alta” únicamente por texto de marca. Puede existir un catálogo/heurística para sugerir la clasificación, pero el dato persistente y auditable debe ser la clasificación del vehículo/reserva.

## 5. Memoria persistente y contexto dinámico

La memoria no debe depender de un único system prompt estático. En cada turno se construirá un contexto dinámico desde Supabase, combinado con el contexto conversacional privado del usuario. De esta forma el asistente conoce siempre el estado vigente del negocio y evita repetir preguntas ya resueltas.

- **Reglas globales persistentes:** Restricciones del negocio, política de gama alta, márgenes, criterios de equilibrio y parámetros del optimizador.
- **Datos estructurados:** Operarios, experiencia, activo/inactivo, tareas, reservas, clasificación del vehículo, tiempos de desplazamiento, disponibilidad y carga.
- **Contexto conversacional por usuario:** Historial necesario para continuar la conversación de ese administrador sin mezclarlo con conversaciones de otros usuarios.
- **Estado operativo en tiempo real:** Se vuelve a consultar en cada turno. Una conversación larga nunca debe congelar permisos, tareas ni disponibilidad antiguos.

## 6. Política de preguntas de la IA

Antes de preguntar, el backend/asistente debe comprobar si el dato ya existe y sigue siendo válido. La IA no debe repetir preguntas que el sistema ya puede responder.

- Si entra un operario nuevo y no tiene `experience_level`, preguntar BAJO / MEDIO / EXPERTO y persistir la respuesta.
- Si el operario está inactivo, ignorarlo; no preguntar por su experiencia para esa optimización.
- Si un vehículo relevante no tiene clasificación y esta es necesaria para garantizar la regla de gama alta, solicitar la clasificación al Admin y guardarla.
- Si un dato ya está persistido, no volver a preguntarlo salvo que el Admin solicite modificarlo.
- Distinguir preguntas bloqueantes de advertencias no bloqueantes. Una restricción de seguridad/experiencia no puede resolverse con una suposición silenciosa.

## 7. Modelo de tiempos y movilidad

Para una primera versión se recomienda una matriz de tiempos calibrada entre Parking, T1, T2, T3/T4/T4S según las ubicaciones operativas reales. El optimizador usará esos tiempos junto con duración de recepción, fotos, aparcamiento, entrega y márgenes. Posteriormente los tiempos pueden ajustarse por franja horaria usando datos históricos/GPS.

Ejemplo conceptual: Parking→T4, T4→Parking, T1→T4, etc. Los valores concretos deben calibrarse con la operación real y no inventarse en el modelo.

## 8. Seguridad, permisos y aislamiento de sesiones

Esta parte es una condición de seguridad. La IA nunca debe consumir indiscriminadamente los mensajes que llegan por Telegram. Todo texto debe atravesar una pasarela de autorización antes de llegar al modelo.

**Mensaje Telegram → validar telegram_user_id → active → permiso vigente lectura/escritura → sesión IA del usuario → modelo**

- Solo un usuario con permiso vigente de lectura/escritura de Gestión de Reservas puede interactuar con el asistente.
- El permiso se verifica EN CADA MENSAJE, no únicamente al abrir la sesión.
- Las notificaciones de Telegram y eventos del sistema no son entradas conversacionales para la IA.
- Un texto de otro usuario no debe incorporarse al contexto de la sesión, aunque llegue al mismo bot/canal.
- Cada sesión se asocia como mínimo a `telegram_user_id + ai_session_id`.
- Si el usuario pierde el permiso a mitad de la sesión, sus siguientes mensajes dejan de procesarse inmediatamente.
- Si posteriormente recupera permiso, puede reanudar su propio contexto según la política de retención, pero nunca hereda el contexto privado de otro Admin.
- Si el permiso de escritura se transfiere a otro administrador, el nuevo titular utiliza su propia sesión/contexto.
- La IA no escribe directamente en tablas. Una propuesta confirmada utiliza las APIs/RPC existentes, incluyendo control de versión y permisos.

## 9. Contexto por usuario frente a contexto compartido

| Contexto privado del usuario | Contexto compartido del negocio |
| --- | --- |
| Conversación del Admin con el asistente | Reglas globales de optimización |
| Aclaraciones temporales dadas por ese Admin | Operarios activos y experiencia |
| Propuestas previas de su sesión | Reservas y tareas actuales |
| Preferencias conversacionales que no sean reglas globales | Tiempos, clasificación de vehículos y carga |

El contexto compartido se reconstruye/actualiza desde Supabase en cada turno. El contexto privado no se mezcla entre administradores.

## 10. Flujo de interacción propuesto

1. Root/Admin pulsa “Asistente IA” en Gestión de Reservas.
2. El backend valida identidad, actividad y permiso vigente de lectura/escritura.
3. Se crea o recupera la sesión privada del `telegram_user_id`.
4. Se carga el contexto dinámico del negocio y se detectan datos bloqueantes faltantes.
5. Si falta experiencia o clasificación, la IA pregunta únicamente por esos datos y la respuesta se persiste.
6. El motor de optimización calcula una propuesta factible respetando restricciones duras.
7. La IA presenta por chat el reparto, motivos, carga, desplazamientos y posibles incidencias.
8. El Admin confirma o solicita cambios.
9. Antes de ejecutar se vuelven a validar permisos y versiones de las tareas.
10. La API existente realiza la asignación; la última asignación confirmada sigue siendo la válida.

## 11. Datos adicionales recomendados

Diseño conceptual; los nombres definitivos deben revisarse contra el esquema actual antes de crear migraciones.

| Entidad | Campo/tabla conceptual | Uso |
| --- | --- | --- |
| workers | experience_level | BAJO / MEDIO / EXPERTO |
| vehicle/reservation | vehicle_handling_level | NORMAL / GAMA_ALTA |
| dispatch configuration | dispatch_rules | Reglas versionadas y parámetros |
| travel model | travel_times | Tiempos entre ubicaciones/franjas |
| AI assistant | ai_sessions | Sesión por telegram_user_id |
| AI assistant | ai_messages / session context | Contexto conversacional auditable según política de retención |
| availability | worker_availability | Disponibilidad/turnos/excepciones |

## 12. Función objetivo orientativa

El optimizador debe encontrar primero una solución que cumpla todas las restricciones duras y, entre las soluciones válidas, minimizar una combinación ponderada de:

- tiempo total de desplazamiento
- kilómetros/movimientos innecesarios
- riesgo de llegar tarde
- desequilibrio de carga entre operarios
- tiempos muertos
- número de retornos innecesarios al parking

El transporte conjunto de operarios se incorporará como una extensión del modelo una vez validada la V1, porque introduce dependencias entre rutas y recursos compartidos.

## 13. Alcance recomendado de V1

- Botón Asistente IA solo para usuarios autorizados.
- Sesiones independientes por `telegram_user_id` y revalidación de permisos en cada mensaje.
- Experiencia persistente de operarios.
- Clasificación NORMAL/GAMA_ALTA y EXPERTO obligatorio para gama alta.
- Solo operarios activos y disponibles.
- Pickup y delivery como tareas independientes.
- Matriz de tiempos Parking/Terminales.
- Balance de carga y compatibilidad temporal.
- Motor de optimización determinista (p. ej. OR-Tools/CP-SAT).
- IA para diálogo, detección de datos faltantes y explicación.
- Confirmación humana antes de ejecutar cambios.
- Uso de `reservation-task-api`/RPC y control de `version` para materializar asignaciones.

## 14. Reglas que no deben romperse

- La asignación de una tarea no cambia el estado operativo del coche.
- Una tarea `completed`/`cancelled` no debe volver a asignarse.
- Un operario inactivo no es candidato.
- GAMA_ALTA nunca se asigna automáticamente a BAJO o MEDIO.
- El LLM no debe poder saltarse restricciones del solver/backend.
- Una notificación Telegram nunca debe interpretarse como una instrucción del Admin.
- No confiar en permisos almacenados al inicio de sesión: se revalidan en cada turno y antes de cualquier escritura.
- No mezclar conversaciones/contextos privados de diferentes usuarios.

## 15. Próximo paso antes de implementar

Antes de modificar código o base de datos se debe revisar el esquema y APIs actuales, definir los tiempos operativos reales, disponibilidad/turnos y reglas exactas de clasificación. Después se puede diseñar la migración mínima y un prototipo del optimizador que opere primero en modo propuesta, sin escritura automática.
