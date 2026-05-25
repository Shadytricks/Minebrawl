# 💣 Mine Brawl

Online multiplayer Bomberman-style brawler. Up to 4 players per lobby.

## Project Structure

```
mine-brawl/
├── server/
│   ├── server.js       ← WebSocket game server (Node.js)
│   └── package.json
└── client/
    └── index.html      ← Complete game frontend (no framework)
```

---

## 🚀 Deploy in 10 minutes

### Step 1 — Push to GitHub

1. Create a new repo on [github.com](https://github.com)
2. Push this entire `mine-brawl/` folder to it

### Step 2 — Deploy the server on Railway

1. Go to [railway.app](https://railway.app) and sign up (free)
2. Click **New Project → Deploy from GitHub repo**
3. Select your repo
4. In project settings → **Root Directory** → set to `server`
5. Railway will auto-detect Node.js and run `npm start`
6. Once deployed, go to **Settings → Networking → Generate Domain**
7. Copy the domain — it looks like `mine-brawl-server.up.railway.app`

### Step 3 — Update the server URL in the client

Open `client/index.html` and find this line near the top of the `<script>`:

```js
const SERVER_URL = "wss://your-server.railway.app"; // ← UPDATE THIS
```

Replace it with your Railway domain:
```js
const SERVER_URL = "wss://mine-brawl-server.up.railway.app";
```

### Step 4 — Deploy the frontend on Netlify

1. Go to [netlify.com](https://netlify.com) and sign up (free)
2. Click **Add new site → Deploy manually**
3. Drag and drop your `client/` folder onto the deploy area
4. Done — you'll get a URL like `https://mine-brawl.netlify.app`

Share that URL with friends and start playing!

---

## 🎮 Controls

| Action       | Key         |
|--------------|-------------|
| Move         | Arrow Keys  |
| Place Mine   | Space       |
| Sword Attack | F           |

---

## 🏗 Architecture

- **Server**: Authoritative Node.js WebSocket server. Runs game logic at 20 ticks/sec, broadcasts state to all clients.
- **Client**: Pure HTML/CSS/JS. Sends player inputs to server, renders whatever state it receives.
- **Lobby**: One global lobby at a time. Players join with a 4-letter code.

---

## 🔧 Local Development

```bash
# Run server locally
cd server
npm install
npm run dev

# In client/index.html, change SERVER_URL to:
const SERVER_URL = "ws://localhost:8080";

# Open client/index.html directly in your browser
# (or use: npx serve client)
```
