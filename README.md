# ParkingMartin-G

MVP de gestión de vehículos de parking mediante **Telegram + Supabase/PostgreSQL + Supabase Storage + GitHub Pages**, orientado a operarios que reciben, aparcan, localizan y entregan vehículos.

> Estado (30/08/2026): flujo operativo Telegram, GPS preciso, expediente web de vehículo, OCR al aparcar y gestión de usuarios/roles funcionales. La configuración manual por sectores queda descartada para esta versión.

## Objetivo

El operario trabaja principalmente desde Telegram. El sistema mantiene trazabilidad de matrícula, ubicación, fotografías, documentación, operario, fecha/hora e historial del vehículo.

Volumen de diseño inicial: **un parking y aproximadamente 150 vehículos/día**.

## Flujo operativo

### Aeropuerto · Recogida

Registra la recepción del vehículo en el aeropuerto y conserva las evidencias correspondientes. La fotografía de matrícula de esta etapa se conserva como evidencia, pero **no se ejecuta OCR aquí**.

### Aparcar

Flujo objetivo:

1. Introducir matrícula.
2. Poder cancelar la operación mientras se espera texto del operario.
3. Solicitar una **foto clara de la matrícula**.
4. Ejecutar OCR mediante Google Cloud Vision y comparar con la matrícula introducida.
5. Si coincide: mostrar **MATRÍCULA VERIFICADA** y continuar.
6. Si no coincide o no puede leerse: permitir **REPETIR FOTO**, **IGNORAR Y CONTINUAR** o **CANCELAR**.
7. Cualquier override/ignorado queda auditado con operario, fecha/hora, matrícula esperada/detectada y evidencia.
8. Obtener ubicación GPS precisa mediante Telegram Mini App.
9. El operario revisa la precisión y pulsa **USAR ESTA UBICACIÓN**.
10. La Mini App confirma el envío, espera aproximadamente 2 segundos, se cierra y vuelve automáticamente al chat para finalizar la confirmación.

**OCR se utiliza únicamente al aparcar el vehículo.** No se realiza OCR durante Recogida ni durante la salida del parking.

### Buscar vehículo

Permite localizar un vehículo por matrícula y recuperar su información de parking.

Cuando el vehículo está actualmente aparcado puede mostrarse **NAVEGAR HASTA EL COCHE**, abriendo Google Maps con las coordenadas guardadas.

El botón de navegación **solo debe existir cuando el estado actual sea `parked`**. Si el vehículo ya no está en el parking, las coordenadas pueden conservarse como información histórica, pero no debe ofrecerse navegación hacia ellas.

### Aeropuerto · Entrega

Registra la salida/entrega del vehículo y actualiza su estado e historial. No requiere OCR de matrícula en la versión actual.

## Otras opciones

El menú no incluye un botón `CERRAR`, porque dejaba al operario sin acciones útiles.

Debe mantener disponibles las operaciones reales y **CONSULTAR VEHÍCULO**. Para usuarios con rol `owner` o `admin` aparece además **GESTIONAR OPERARIOS**.

### Consultar vehículo

Abre un expediente web dentro de Telegram. La consulta no modifica el estado operativo del coche.

El expediente debe mostrar, cuando existan:

- matrícula y estado actual;
- fecha/hora de aparcado y última actualización;
- ubicación GPS y precisión;
- referencia textual de ubicación;
- navegación únicamente si sigue aparcado;
- fotografías y documentación;
- verificaciones OCR y overrides;
- operario responsable de cada evidencia/acción;
- historial cronológico completo.

La interfaz usa nombres comprensibles en español, no nombres internos como `lookup`, `park`, `pickup` o `retrieve`.

### Organización de fotografías

Las evidencias se muestran **de la más nueva a la más antigua** y agrupadas por:

1. **día**, y
2. **lugar/etapa** (por ejemplo `Aeropuerto · Recogida`, `Parking · Aparcado`).

Cada fotografía/documento debe indicar **tipo de evidencia, hora y operario que la tomó/subió**.

Los archivos permanecen en almacenamiento privado y se consultan mediante URLs firmadas temporales. No se deben crear URLs públicas permanentes.

## Geolocalización: decisión vigente

La localización principal del coche es **GPS preciso**.

Se conserva:

- latitud/longitud;
- precisión horizontal en metros;
- referencia textual cuando sea útil;
- navegación mediante Google Maps mientras el vehículo permanezca aparcado.

### Sectores descartados

**No se implementará configuración manual del parking por sectores en esta versión.**

Quedan descartados del flujo activo:

- selección manual de sector;
- obligación de configurar el terreno;
- palabra `Configurar` para definir sectores;
- uso de sectores como fallback habitual del GPS.

Las tablas o código histórico relacionados con sectores pueden existir todavía, pero **no representan el diseño funcional vigente** y no deben reintroducirse en el flujo sin una decisión posterior explícita.

Si la experiencia real demuestra zonas donde el GPS falla sistemáticamente, podrá evaluarse en el futuro un mecanismo auxiliar, pero no forma parte del MVP actual.

## Arquitectura actual

```text
Telegram Bot
   |
   | webhook HTTPS
   v
Supabase Edge Functions
   |
   +--> PostgreSQL
   |      - usuarios/operarios y permisos
   |      - vehicles
   |      - parking_events
   |      - evidencias/fotos
   |      - auditoría
   |      - verificaciones OCR
   |      - user_admin_events
   |
   +--> Supabase Storage (privado)
   |
   +--> Google Cloud Vision (OCR solo al aparcar)
   |
   +--> Telegram Mini Apps
            |
            +--> GPS preciso
            +--> Consultar vehículo
                    |
                    +--> interfaz alojada en GitHub Pages
```

## Seguridad y auditoría

- `TELEGRAM_BOT_TOKEN`, claves de Supabase y `GOOGLE_VISION_API_KEY` se mantienen como secretos de backend; nunca en GitHub ni en HTML público.
- El acceso se controla por usuario de Telegram y estado activo/inactivo.
- Un trabajador desactivado debe perder acceso al bot.
- Las fotos/documentos se almacenan de forma privada.
- Los overrides de OCR quedan auditados.
- Las acciones importantes conservan operario y fecha/hora.
- La Mini App/expediente valida que la petición procede de una sesión válida de Telegram antes de exponer datos del vehículo.

## UX acordada

- Cuando se espera matrícula u otro texto libre importante, ofrecer **CANCELAR** sin sustituir el teclado normal.
- Evitar pantallas sin acciones útiles.
- La ubicación precisa debe poder revisarse antes de aceptarla.
- Tras aceptar la ubicación, esperar ~2 s, cerrar la Mini App y regresar al chat.
- `NAVEGAR HASTA EL COCHE` solo aparece para vehículos actualmente aparcados.
- `CONSULTAR VEHÍCULO` permanece disponible en Otras opciones y funciona como expediente informativo completo.

## Control de acceso y roles

El modelo vigente tiene tres niveles:

### 👑 Owner / Propietario

Existe una única cuenta `owner`. Es la cuenta propietaria original del sistema.

- Siempre permanece activa.
- No puede ser degradada a `admin` u `operario`.
- No puede ser bloqueada ni eliminada.
- La protección existe **en PostgreSQL mediante trigger**, no únicamente en la interfaz de Telegram.
- Existe un índice único que impide crear un segundo `owner` mientras el propietario actual exista.

### 🛡️ Administrador

Un administrador activo puede:

- ver solicitudes pendientes;
- autorizar nuevos operarios;
- autorizar directamente un nuevo administrador;
- promover un operario existente a administrador;
- quitar el rol de administrador a otros administradores;
- dar de baja usuarios;
- reactivar usuarios bloqueados;
- rechazar solicitudes pendientes.

Ningún administrador puede modificar los permisos del `owner`.

Para evitar errores accidentales, un administrador tampoco puede cambiar **sus propios** permisos desde el panel; otro administrador/owner debe hacerlo.

### 👤 Operario

Puede utilizar los flujos operativos del parking, pero no ve ni puede usar la gestión de usuarios.

### Panel `GESTIONAR OPERARIOS`

Solo aparece a `owner` y `admin` dentro de **OTRAS OPCIONES**.

Organiza los usuarios en:

- **SOLICITUDES PENDIENTES**;
- **OPERARIOS ACTIVOS**;
- **ADMINISTRADORES**;
- **USUARIOS BLOQUEADOS**.

Las acciones disponibles dependen del estado y rol del usuario seleccionado: `AUTORIZAR COMO OPERARIO`, `AUTORIZAR COMO ADMIN`, `HACER ADMINISTRADOR`, `QUITAR ADMINISTRADOR`, `DAR DE BAJA`, `REACTIVAR` o `RECHAZAR`.

La cuenta `owner` muestra **CUENTA PROTEGIDA** y no presenta acciones destructivas.

### Auditoría administrativa

Todos los cambios de permisos se registran en `user_admin_events` con:

- administrador que realizó la acción;
- usuario afectado;
- acción ejecutada;
- rol anterior/nuevo;
- estado activo anterior/nuevo;
- fecha/hora;
- metadata adicional cuando corresponda.

Las solicitudes rechazadas no vuelven automáticamente a pendientes simplemente porque el usuario escriba de nuevo al bot.

## Documentación adicional

- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/CODEX_IMPLEMENTATION_PLAN.md`
- `docs/TEST_PLAN.md`

Estos documentos históricos deben interpretarse conforme a las decisiones vigentes de este README, especialmente la **eliminación del diseño por sectores**, el **OCR únicamente al aparcar** y el **modelo owner/admin/operario**.
