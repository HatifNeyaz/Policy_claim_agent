# Library Contents Claim Agent

## 1. Introduction

**Library Contents Claim Agent** is a browser-based, live voice-and-vision insurance claim application designed for smartphones. In a single continuous camera walk through a room, the app segments and reads book spines, detects non-book room items (beds, tables, chairs, shelving, electronics, lamps, rugs, and wall art), calculates metric dimensions, looks up verifiable local market prices, and exports a complete adjuster claim packet (`.zip` containing `claim_packet.json`, `claim_report.html`, and `evidence_frames`)

Because all AI and packaging libraries (`@mediapipe/tasks-vision` and `JSZip`) load directly inside the browser over HTTPS CDNs, there are **zero packages to install** (`no npm install`, `no pip install`, and zero build steps).


# Working video link:
```bash
https://drive.google.com/file/d/12XEFLJRM0pa8deGDP3e1K2ouXWWsHvUu/view
```

# How to use the app:
1. Go to policyclaimagent.vercel.app
2. Paste your Gemini/Groq key as per the ai model you wish to use from menu.
3. Allow camera and microphone access when asked.
4. Start the camera spanning and when done click finish and you'll get your report

## 2. Detailed Reproducibility Guide (Step-by-Step in Plain English)

Because smartphone browsers (Android Chrome and iOS Safari) strictly require a secure **`https://`** connection to turn on the phone camera, microphone, and 3D orientation sensors, the easiest way to reproduce and run this app on your phone is to clone the code to your PC, push it to your GitHub account, and host it for free on **Vercel** in under 5 minutes.

### Step 1: Clone the Repository to Your PC
1. Open the terminal (or Command Prompt / Git Bash) on your computer.
2. Run the following command to download the project folder:
   ```bash
   git clone https://github.com/HatifNeyaz/Policy_claim_agent.git
   ```

3. Move into the downloaded project folder:Bashcd Policy_claim_agent

### Step 2: Upload the Repository to Your Own GitHub AccountTo deploy the app on your own Vercel account, upload this folder to a repository on your GitHub profile:
1. Log in to https://github.com and click the + icon in the top-right corner --> New repository.
2. Give your repository a name (for example, my-policy-claim-agent), keep it Public or Private, and click Create repository (do not check "Add a README").
3. Copy your new repository's HTTPS URL (e.g., https://github.com/YOUR_USERNAME/my-policy-claim-agent.git).
4. In your PC terminal (inside the Policy_claim_agent folder), point Git to your new repository and push the code:
```bash 
git remote set-url origin https://github.com/YOUR_USERNAME/my-policy-claim-agent.git
git branch -M main
git push -u origin main

```
### Step 3: Deploy Your GitHub Repository on Vercel
1. Go to https://vercel.com and click Sign Up or Log In --> choose Continue with GitHub.
2. On your Vercel dashboard, click Add New... --> Project.
3. Under Import Git Repository, find your my-policy-claim-agent repository and click Import.
4. Leave all build settings completely default (this is a pure static HTML/JS app, so no build command is needed) and click Deploy.
5. In about 15 seconds, Vercel will give you a live https://...vercel.app link. You can now open this exact link on your smartphone browser!

### Step 4: Get a Free Gemini API Key (or Groq API Key)
You only need one free API key (no secrets are committed to the repo; see .env.example for reference):   

Option A — Google Gemini API Key (Recommended):
* Go to https://aistudio.google.com/apikey.
* Click Create API key and copy the key string.

Option B — Groq Cloud API Key (Optional Alternative):

* Go to https://console.groq.com/keys.
* Click Create API Key and copy the gsk_... key string.

### Step 5: Paste Your API Key in the App UI
**(Note: Save your screenshot as docs/ui_api_key_guide.png or update the image path above to match your screenshot filename.)** 

What to do on this screen:
1. Open your https://...vercel.app link on your phone (or PC).
2. At the top of the screen, tap ⚙️ Setup, API Key & Spatial Sensitivity if it is not already open.
3. Locate the API Key (Google AI Studio / Groq) input box shown in the image above.
4. Paste your Gemini API key or Groq API key directly into that box and tap the 🔌 Test button right next to it.
5. A confirmation message (✅ Connected!) will pop up, and your browser will remember the key locally so you do not have to paste it again.

### Step 6: How to Run the Sweep on Your Phone (or Locally on PC)Running on Your Smartphone (Primary Method)
1. After pasting your API key, select your Primary Country & Currency (e.g., India (INR ₹) or United States (USD $)) and your 2nd Country (10-Book Proof).
2. Tap the green 📹 Start Sweep button and click Allow when your phone asks for Camera and Microphone permissions.
3. Walk slowly across your room, pointing the camera at your bookshelves and room items (beds, tables, chairs, lamps, framed art.
* Every time you pan into a new area and pause for half a second, you will hear a camera shutter click and see the photo appear in the bottom filmstrip.
* Everything seen is automatically counted as yours. If you want to exclude a shelf or mark a wall picture as a print, tap 🚫 Not Mine or 🖼️ Art = Print (or say it out loud).
4. When finished, tap the red ⏹️ Finish & Report button.
5. Within seconds, your complete report will appear on screen. Tap 📦 Download Full Claim Packet (.ZIP) to save claim_packet.json, claim_report.html, and all evidence_frames.jpg photos in one file.   