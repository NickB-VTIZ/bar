# ☀️ Zomerbar POS v2

Self-hosted bestelsysteem voor popup bars — klanten bestellen zelf via QR en betalen online (Bancontact/kaart via Mollie), personeel slaat walk-up cash- en kaartverkopen aan op de balie-kassa, en iedereen volgt het bestelnummer live.

## Features

- 📱 **Klantbestelpage** — menu, bestellen, online betalen (Mollie: Bancontact/kaart), live bestelnummer
- 🛒 **Balie-kassa** — personeel slaat walk-up verkopen aan: cash of kaart (SumUp-lezer). Komt meteen in het kasdagboek.
- 🖥 **Bar-dashboard** — realtime bestellingen met bestelnummer, stock alerts
- 📦 **Stockbeheer** — automatisch aftrekken bij verkoop, lage stock waarschuwing
- 📒 **Kasdagboek & maandfactuur** — BTW-overzicht, export naar Billit
- 🔌 **Realtime** — WebSockets, geen polling, geen Firebase
- 🗄 **SQLite** — alles lokaal opgeslagen, geen externe database

---

## Beveiliging

Het admin-gedeelte (bar-dashboard, boekhouding, instellingen, SumUp-sync) is afgeschermd met een wachtwoord. De klantbestelpagina blijft open zodat klanten zonder login kunnen bestellen.

**Standaard wachtwoord:** `zomerbar2025`

**Wijzig dit meteen** op één van twee manieren:

1. In de Docker-compose: pas `ADMIN_PASSWORD` aan vóór de eerste start
2. Na inloggen: bar-dashboard → ⚙️ Instellingen → Beveiliging → nieuw wachtwoord

Na inloggen blijft je sessie 30 dagen geldig (token in de browser). Beveiligde server-endpoints kunnen niet omzeild worden — de afscherming zit in de backend, niet enkel in de frontend.

> **Belangrijk:** zet het systeem achter HTTPS als het via internet bereikbaar is, zodat het wachtwoord versleuteld verstuurd wordt. Op Hostinger kan dit via een reverse proxy (Nginx Proxy Manager) met gratis Let's Encrypt certificaat.

---

## Snel starten (lokaal)

```bash
git clone https://github.com/NickB-VTIZ/bar.git
cd bar
docker compose up -d --build
open http://localhost:3000
```

---

## Deployen op Hostinger VPS

### Optie 1 — Via SSH (aanbevolen, werkt altijd)

```bash
# SSH in op je VPS via Hostinger Terminal
git clone https://github.com/NickB-VTIZ/bar.git /opt/zomerbar
cd /opt/zomerbar
docker compose up -d --build
```

De app draait daarna op `http://JOUW-VPS-IP:3000`.

### Optie 2 — Via Hostinger Docker Manager

1. Wacht tot GitHub Actions het image heeft gebouwd (`github.com/NickB-VTIZ/bar/actions`)
2. Zet het package publiek: GitHub → Profiel → Packages → bar → Package settings → Public
3. Hostinger → Docker Manager → Compose from URL:
   ```
   https://raw.githubusercontent.com/NickB-VTIZ/bar/main/compose.hostinger.yml
   ```

---

## Gebruik

| URL | Wie | Apparaat |
|-----|-----|---------|
| `/` | Startpagina + QR-code | Alles |
| `/bestel.html` | Klant bestelt en betaalt online | Gsm via QR |
| `/pos.html` | Personeel slaat balieverkoop aan 🔒 | Tablet aan de balie |
| `/bar.html` | Barman beheert bestellingen 🔒 | Tablet achter de bar |
| `/kasdagboek.html` | Boekhouding & maandfactuur 🔒 | Alles |

### Workflow — klant via QR
1. **QR-code** op elke tafel leggen (gegenereerd op `/`)
2. **Klant** scant → ziet menu → bestelt → betaalt online (Bancontact/kaart via Mollie) → krijgt bestelnummer
3. **Barman** ziet betaalde bestelling op `/bar.html` → bereidt → markeert als klaar
4. **Klant** krijgt melding → haalt op aan bar met bestelnummer

### Workflow — verkoop aan de balie
1. **Personeel** opent `/pos.html`, tikt de producten aan
2. Kiest **Cash** (geld ontvangen) of **Kaart** (afrekenen op SumUp-lezer)
3. Bevestigt → verkoop is meteen geregistreerd en verschijnt in het **kasdagboek**

---

## Instellingen

Via **bar-dashboard → ⚙️ Instellingen**:

- **Mollie API-sleutel** → `live_…` / `test_…` via mollie.com → Developers → API-keys (online klantbetaling; zet Bancontact actief in je Mollie-account)
- **SumUp** → API-sleutel + Merchant code + **Reader-ID** voor de terminal aan de balie
- **BTW** → standaardtarieven voor nieuwe producten (6% dranken / 12% maaltijden). **Per product** stel je een eigen tarief in (6/12/21%) via *Menu beheren*.
- **Billit** → API-sleutel + omgeving voor de maandfactuur

> Producten beheer je rechtstreeks in het systeem (bar-dashboard → ⚙️ Instellingen → **Menu beheren**: toevoegen, prijs, emoji, BTW-tarief, voorraad). De vroegere "SumUp catalog sync" is verwijderd: SumUp biedt geen publieke producten-API, dus die kon nooit werken.

---

## Mollie betaalflow (klant via QR)

1. Klant kiest **Online betalen** → systeem maakt een Mollie-betaling aan
2. Klant wordt doorgestuurd naar de Mollie-betaalpagina (Bancontact / kaart)
3. Na betaling stuurt Mollie de klant terug naar de bestelpagina
4. Bevestiging gebeurt via de **webhook** (`/api/webhooks/mollie`); als fallback pollt de pagina elke 3 s
5. Bij bevestiging → stock aftrekken → bestelling verschijnt op het bar-dashboard

> Mollie heeft een publiek bereikbare **HTTPS**-URL nodig voor de webhook/redirect. De app leidt die automatisch af uit de proxy-headers (`X-Forwarded-*`); zet desnoods de instelling `publicUrl` handmatig.

---

## SumUp terminal aan de balie

Met een **standalone SumUp-toestel** (Solo / terminal) stuurt de balie-kassa het bedrag rechtstreeks naar het toestel via de SumUp Reader-API:

1. In `/pos.html` sla je de producten aan → **Afrekenen** → **Kaart op SumUp-toestel**
2. Het bedrag verschijnt op de terminal; de klant betaalt
3. Het resultaat komt binnen via de webhook (`/api/webhooks/sumup`); bij succes is de verkoop geregistreerd
4. Als fallback is er ook **Kaart (manueel)** — voor wanneer je elders al afrekende

Vereist in de instellingen: **SumUp API-sleutel**, **Merchant code** en **Reader-ID**. Het toestel moet een standalone reader zijn (een Air-lezer die via de gsm-app werkt, kan niet op afstand aangestuurd worden).

> De exacte payload van de SumUp reader-webhook kan per toestel verschillen — test dit één keer met je toestel en controleer dat een betaalde verkoop in het kasdagboek verschijnt.

---

## Backup database

```bash
docker run --rm -v zomerbar_data:/data -v $(pwd):/backup alpine \
  cp /data/zomerbar.db /backup/zomerbar-backup-$(date +%Y%m%d).db
```

---

## API endpoints

| Methode | Endpoint | Omschrijving |
|---------|----------|-------------|
| GET | `/api/products` | Alle producten |
| POST | `/api/products` | Product toevoegen |
| PUT | `/api/products/:id` | Product aanpassen |
| PATCH | `/api/products/:id/stock` | Stock instellen |
| GET | `/api/orders` | Actieve bestellingen |
| POST | `/api/orders` | Bestelling aanmaken (cash / balie / Mollie) |
| PATCH | `/api/orders/:id/status` | Status wijzigen |
| GET | `/api/orders/:id/payment-status` | Betaalstatus pollen (Mollie/SumUp) |
| POST | `/api/webhooks/mollie` | Mollie betaal-webhook |
| POST | `/api/pos/sumup-terminal` | Bedrag naar SumUp-terminal sturen |
| POST | `/api/webhooks/sumup` | SumUp terminal betaal-webhook |
| GET | `/api/transactions` | Betaalde verkopen van vandaag |
| GET | `/api/stats` | Stats van vandaag |
| GET/POST | `/api/settings` | Instellingen |
| GET | `/api/health` | Health check |
| WS | `ws://SERVER:3000` | Realtime updates |
