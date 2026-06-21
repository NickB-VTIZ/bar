# ☀️ Zomerbar POS v2

Self-hosted bestelsysteem voor popup bars — klanten bestellen zelf via QR, betalen met SumUp of cash, en volgen hun bestelnummer live.

## Features

- 📱 **Klantbestelpage** — menu, bestellen, betalen (SumUp / cash), live bestelnummer
- 🖥 **Bar-dashboard** — realtime bestellingen met bestelnummer, stock alerts
- 📦 **Stockbeheer** — automatisch aftrekken bij verkoop, lage stock waarschuwing
- 🔄 **SumUp sync** — producten importeren uit SumUp catalog, checkouts aanmaken
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
| `/bestel.html` | Klant bestelt en betaalt | Gsm via QR |
| `/bar.html` | Barman beheert bestellingen | Tablet |

### Workflow
1. **QR-code** op elke tafel leggen (gegenereerd op `/`)
2. **Klant** scant → ziet menu → bestelt → betaalt (SumUp of cash) → krijgt bestelnummer
3. **Barman** ziet bestelling op `/bar.html` → bereidt → markeert als klaar
4. **Klant** krijgt melding → haalt op aan bar met bestelnummer

---

## Instellingen

Via **bar-dashboard → ⚙️ Instellingen**:

- **SumUp API-sleutel** → `sup_sk_…` via [me.sumup.com/settings/api-keys](https://me.sumup.com/settings/api-keys)
- **SumUp Merchant ID** → te vinden in je SumUp-profiel
- **BTW-tarieven** → 6% dranken / 12% maaltijden
- **SumUp catalog sync** → importeert producten automatisch

---

## SumUp betaalflow

Bij kaartbetaling:
1. Systeem maakt een SumUp Checkout aan via de API
2. Klant krijgt een betaallink (`pay.sumup.com/...`)
3. Klant betaalt op zijn gsm
4. Systeem pollt elke 3 seconden op betaalstatus
5. Bij bevestiging → stock aftrekken → bestelling naar bar

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
| POST | `/api/products/sync-sumup` | Sync met SumUp catalog |
| GET | `/api/orders` | Actieve bestellingen |
| POST | `/api/orders` | Bestelling aanmaken + SumUp checkout |
| PATCH | `/api/orders/:id/status` | Status wijzigen |
| GET | `/api/orders/:id/payment-status` | SumUp betaalstatus pollen |
| GET | `/api/stats` | Stats van vandaag |
| GET/POST | `/api/settings` | Instellingen |
| GET | `/api/health` | Health check |
| WS | `ws://SERVER:3000` | Realtime updates |
