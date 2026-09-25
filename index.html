<!DOCTYPE html>
<html lang="ro">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Configurare - RO Sub Translator</title>
    <style>
        body {
            background-color: #121212;
            color: #ffffff;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: flex-start;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
            box-sizing: border-box;
        }
        .container {
            max-width: 400px;
            width: 100%;
            padding-bottom: 40px;
        }
        h1 {
            color: #00ff7f; /* Verdele vibrant din imagini */
            font-size: 26px;
            margin-bottom: 8px;
            text-align: center;
            font-weight: bold;
        }
        .version-badge {
            font-size: 0.45em;
            background-color: #8a5ae9; /* Bulina specifică Stremio */
            color: #ffffff;
            padding: 4px 10px;
            border-radius: 20px;
            vertical-align: middle;
            margin-left: 8px;
            font-weight: 600;
            letter-spacing: 0.5px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        }
        p.subtitle {
            text-align: center;
            color: #999999;
            margin-top: 0;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .input-group {
            margin-bottom: 15px;
        }
        label {
            display: block;
            margin-bottom: 6px;
            font-size: 13px;
            color: #bbbbbb;
        }
        input[type="text"] {
            width: 100%;
            background-color: #1e1e1e;
            color: #ffffff;
            border: 1px solid #333333;
            border-radius: 8px;
            padding: 12px 15px;
            font-size: 14px;
            font-family: monospace;
            box-sizing: border-box;
            transition: border-color 0.2s;
        }
        input[type="text"]:focus {
            outline: none;
            border-color: #00ff7f;
        }
        input[type="text"]::placeholder {
            color: #555555;
        }
        .btn-install {
            display: block;
            width: 100%;
            background-color: #00e676; /* Verde deschis pentru buton */
            color: #000000;
            border: none;
            padding: 16px;
            border-radius: 8px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            text-align: center;
            text-decoration: none;
            margin-top: 25px;
            transition: background-color 0.3s ease;
        }
        .btn-install:hover {
            background-color: #00c853;
        }
        .footer {
            text-align: center;
            color: #00ffff; /* Cyan-ul din footer */
            font-family: 'Courier New', Courier, monospace;
            font-size: 12px;
            margin-top: 30px;
            line-height: 1.5;
        }
    </style>
</head>
<body>

    <div class="container">
        <!-- Titlul cu bulina de versiune injectată automat de server -->
        <h1>RO Sub Translator <span class="version-badge">v{{VERSION}}</span></h1>
        <p class="subtitle">Introdu cele 10 chei API Google Gemini</p>
        
        <div id="keys-container">
            <!-- 10 câmpuri de input -->
            <div class="input-group"><label>Cheia 1:</label><input type="text" id="key1" placeholder="AIzaSy..."></div>
            <div class="input-group"><label>Cheia 2:</label><input type="text" id="key2" placeholder="AIzaSy..."></div>
            <div class="input-group"><label>Cheia 3:</label><input type="text" id="key3" placeholder="AIzaSy..."></div>
            <div class="input-group"><label>Cheia 4:</label><input type="text" id="key4" placeholder="AIzaSy..."></div>
            <div class="input-group"><label>Cheia 5:</label><input type="text" id="key5" placeholder="AIzaSy..."></div>
            <div class="input-group"><label>Cheia 6:</label><input type="text" id="key6" placeholder="AIzaSy..."></div>
            <div class="input-group"><label>Cheia 7:</label><input type="text" id="key7" placeholder="AIzaSy..."></div>
            <div class="input-group"><label>Cheia 8:</label><input type="text" id="key8" placeholder="AIzaSy..."></div>
            <div class="input-group"><label>Cheia 9:</label><input type="text" id="key9" placeholder="AIzaSy..."></div>
            <div class="input-group"><label>Cheia 10:</label><input type="text" id="key10" placeholder="AIzaSy..."></div>
        </div>
        
        <a href="#" id="installLink" class="btn-install">Instalează în Stremio</a>
        
        <div class="footer">
            // System status: Operational. Powered<br>by Chios.
        </div>
    </div>

    <script>
        // Adăugăm un "ascultător" pe toate cele 10 câmpuri de text
        for (let i = 1; i <= 10; i++) {
            document.getElementById('key' + i).addEventListener('input', updateLink);
        }

        function updateLink() {
            let keysArray = [];
            
            // Colectăm valorile din toate cele 10 căsuțe
            for (let i = 1; i <= 10; i++) {
                let val = document.getElementById('key' + i).value.trim();
                if (val !== "") {
                    keysArray.push(val);
                }
            }
            
            // Dacă utilizatorul a introdus cel puțin o cheie validă, generăm link-ul
            if (keysArray.length > 0) {
                const configJson = JSON.stringify(keysArray);
                const base64Config = btoa(configJson);
                
                const currentUrl = window.location.href.replace('https://', '').replace('http://', '').split('/')[0];
                const installUrl = `stremio://${currentUrl}/${base64Config}/manifest.json`;
                
                document.getElementById('installLink').href = installUrl;
            } else {
                document.getElementById('installLink').href = "#";
            }
        }
    </script>
</body>
</html>
