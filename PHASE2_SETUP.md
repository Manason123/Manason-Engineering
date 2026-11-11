# Gukosora "The server is not connected" (BuildTrack Pro)

**Impamvu:** Netlify ibika urubuga (client) gusa. API n'database biri kuri Render.
Urubuga rutazi aderesi ya API ("API: (not set)"), bityo kwinjira ntibikora.

## Intambwe 1: Shyira API kuri Render (niba bitarakorwa)
1. render.com → New → Blueprint → hitamo repository yawe (`render.yaml` irasomwa).
2. Uzuza `ADMIN_EMAIL` (imeri yawe) na `ADMIN_PASSWORD` (inyuguti 8+ n'imibare).
3. Ibyo birangiye, fungura `https://IZINA-RYAWE.onrender.com/api/health`.
   Igomba kwerekana `{"ok":true}`. Iyo ni yo aderesi ya API yawe.

## Intambwe 2: Bwira urubuga aderesi ya API (kuri GitHub, muri telefone)
1. GitHub → `client` → `public` → `config.js` → igishushanyo cy'ikaramu (Edit).
2. Hindura umurongo wa nyuma ube:
   `window.BUILDTRACK_API_URL = "https://IZINA-RYAWE.onrender.com";`
   (nta "/" ku iherezo, nta "/api")
3. Commit changes. Netlify irongera yubake yonyine.

## Intambwe 3: Emerera Netlify kuri API (CORS)
Kuri Render → serivisi → Environment → ongeraho:
`CORS_ORIGIN` = `https://IZINA-RYAWE.netlify.app` (nk'uko ryanditse neza, nta "/" ku iherezo).
Hanyuma Render yongere itangire (Manual Deploy).

## Intambwe 4: Injira
- Mu kibanza cya **Email** andika **imeri** (urugero `wowe@gmail.com`), si izina.
- Injiza imeri na password washyize muri `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
- Ikibaho gitukura kigomba kuba cyavuyeho.

## Ibindi byakosowe muri iyi zip
- Hakuweho `server/index.js` (dosiye ya kera ikoresha `pg` na `cors`, itari muri package.json).
- Hakuweho `client/dist` na `client/noapi.png` (ntibikwiye kuba muri GitHub).
- Hongewe `.gitignore`.
- `render.yaml`: hongewemo `CORS_ORIGIN`.

## Icyitonderwa
Render Free isiba data iyo itangiye bundi bushya. Ku kazi nyakuri koresha plan yishyurwa ifite Disk.
