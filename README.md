# ☀️ Zomerbar POS

Lokaal gehoste POS met realtime bestelbeheer, SQLite database en WebSockets.  
Geen internet, geen Firebase, geen abonnement — gewoon Docker starten en gaan.

---

## Snel starten

```bash
# 1. Pak de map uit en ga erin
cd zomerbar

# 2. Start met Docker Compose
docker compose up -d

# 3. Open in browser
open http://localhost:3000
```

Dat is alles. De database wordt automatisch aangemaakt met standaard producten.

---

## Apps

| URL | Voor wie | Apparaat |
|-----|----------|----------|
| `http://SERVER:3000/` | Startpagina + QR-generator | Alles |
| `http://SERVER:3000/pos.html` | Bediening | Gsm |
| `http://SERVER:3000/bar.html` | Barman | Tablet/scherm |
| `http://SERVER:3000/klant.html?tafel=3` | Klant (via QR) | Eigen gsm |

Vervang `SERVER` door het IP-adres van je computer op het lokale netwerk  
(bv. `192.168.1.42`). Te vinden via `ip addr` (Linux/Mac) of `ipconfig` (Windows).

---

## QR-codes drukken

1. Open `http://SERVER:3000/` op je computer
2. Vul het IP-adres in het QR-veld in
3. Klik "Genereren" → "Afdrukken"
4. Leg de QR-kaartjes op de tafels

---

## Instellingen

Via **POS → ⚙️ Instellingen** sla je op:

- **SumUp API-sleutel** → `sup_sk_…` via [me.sumup.com/settings/api-keys](https://me.sumup.com/settings/api-keys)
- **Billit Client ID + Secret** → voor automatische e-facturatie
- **BTW-tarieven** → 6% dranken / 12% maaltijden (Belgische standaard)
- **Menu beheren** → producten toevoegen of verwijderen

Instellingen worden in de database opgeslagen, niet per browser.

---

## Data

De SQLite-database staat in een Docker-volume (`zomerbar_data`).  
Ze blijft bewaard bij `docker compose down` en herstarten.

**Backup maken:**
```bash
docker run --rm -v zomerbar_data:/data -v $(pwd):/backup alpine \
  cp /data/zomerbar.db /backup/zomerbar-backup.db
```

---

## Updaten

```bash
docker compose down
docker compose build --no-cache
docker compose up -d
```

---

## Lokaal draaien zonder Docker

```bash
npm install
node server.js
```

Vereist Node.js 18+.

---

## API-endpoints

| Methode | Endpoint | Beschrijving |
|---------|----------|--------------|
| GET | `/api/products` | Alle producten |
| POST | `/api/products` | Product toevoegen |
| PUT | `/api/products/:id` | Product aanpassen |
| DELETE | `/api/products/:id` | Product verwijderen |
| GET | `/api/orders` | Actieve bestellingen |
| POST | `/api/orders` | Bestelling aanmaken |
| PATCH | `/api/orders/:id/status` | Status wijzigen |
| DELETE | `/api/orders/:id` | Bestelling archiveren |
| GET | `/api/stats` | Stats van vandaag |
| GET | `/api/transactions` | Transactieoverzicht |
| GET/POST | `/api/settings` | Instellingen |
| WS | `ws://SERVER:3000` | Realtime updates |
