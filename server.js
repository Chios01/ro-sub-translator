<!DOCTYPE html>
<html lang="ro">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Configurare - RO Sub Translator</title>
    <style>
        body {
            background-color: #121212;
            color: #ffffff;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 15px;
            box-sizing: border-box;
        }
        .container {
            max-width: 400px;
            width: 100%;
            padding: 15px;
            padding-bottom: 20px;
            box-sizing: border-box;
        }
        h1 {
            color: #00ff7f;
            font-size: 24px;
            margin-top: 0;
            margin-bottom: 5px;
            text-align: center;
            font-weight: bold;
        }
        .version-badge {
            font-size: 0.45em;
            background-color: #8a5ae9;
            color: #ffffff;
            padding: 3px 8px;
            border-radius: 20px;
            vertical-align: middle;
            margin-left: 6px;
            font-weight: 600;
            letter-spacing: 0.5px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        }
        p.subtitle {
            text-align: center;
            color: #999999;
            margin-top: 0;
            margin-bottom: 20px;
            font-size: 13px;
        }
        .input-group {
            margin-bottom: 8px;
        }
        label {
            display: block;
            margin-bottom: 3px;
            font-size: 12px;
            color: #bbbbbb;
        }
        input[type="text"] {
            width: 100%;
            background-color: #1e1e1e;
            color: #ffffff;
            border: 1px solid #333333;
            border-radius: 6px;
            padding: 8px 12px;
            font-size: 13px;
            font-family: monospace;
            box-sizing: border-box;
            transition: border-color 0.3s, box-shadow 0.3s;
        }
        input[type="text"]:focus {
            outline: none;
            border-color: #8a5ae9;
        }
        
        .btn-validate {
            display: block;
            width: 100%;
            background-color: #8a5ae9;
            color: #ffffff;
            border: none;
            padding: 14px;
            border-radius: 6px;
            font-size: 15px;
            font-weight: bold;
            cursor: pointer;
            text-align: center;
            margin-top: 20px;
            box-sizing: border-box;
            transition: background-color 0.3s ease;
        }
        .btn-validate:hover {
            background-color: #7241d6;
        }
        .btn-validate:disabled {
            background-color: #555555;
            cursor: not-allowed;
            opacity: 0.8;
        }

        .btn-install {
            display: none; 
            width: 100%;
            background-color: #00e676;
            color: #000000;
            border: none;
            padding: 14px;
            border-radius: 6px;
            font-size: 15px;
            font-weight: bold;
            cursor: pointer;
            text-align: center;
            text-decoration: none;
            margin-top: 20px;
            box-sizing: border-box;
            transition: background-color 0.3s ease;
        }
        .btn-install:hover {
            background-color: #00c853;
        }

        #statusMsg {
            text-align: center;
            color: #ff3333;
            font-size: 13px;
            margin-top: 15px;
            margin-bottom: 0;
            font-weight: bold;
            display: none;
        }

        .footer {
            text-align: center;
            color: #00ffff;
            font-family: 'Courier New', Courier, monospace;
            font-size: 14px;
            margin-top: 15px;
            line-height: 1.4;
        }
    </style>
</head>
<body>

    <div class="container">
        <h1>RO Sub Translator <span class="version-badge">v{{VERSION}}</span></h1>
        <p class="subtitle">Introdu cele 10 token-uri de acces</p>
        
        <div id="keys-container">
            <div class="input-group"><label>Token 1:</label><input type="text" id="key1" placeholder="..."></div>
            <div class="input-group"><label>Token 2:</label><input type="text" id="key2" placeholder="..."></div>
            <div class="input-group"><label>Token 3:</label><input type="text" id="key3" placeholder="..."></div>
            <div class="input-group"><label>Token 4:</label><input type="text" id="key4" placeholder="..."></div>
            <div class="input-group"><label>Token 5:</label><input type="text" id="key5" placeholder="..."></div>
            <div class="input-group"><label>Token 6:</label><input type="text" id="key6" placeholder="..."></div>
            <div class="input-group"><label>Token 7:</label><input type="text" id="key7" placeholder="..."></div>
            <div class="input-group"><label>Token 8:</label><input type="text" id="key8" placeholder="..."></div>
            <div class="input-group"><label>Token 9:</label><input type="text" id="key9" placeholder="..."></div>
            <div class="input-group"><label>Token 10:</label><input type="text" id="key10" placeholder="..."></div>
        </div>
        
        <button id="validateBtn" class="btn-validate" onclick="validateKeys()">Verifică Datele</button>
        
        <a href="#" id="installLink" class="btn-install">Instalează în Stremio</a>
        
        <p id="statusMsg"></p>
        
        <div class="footer">
            // System status: Operational. Powered<br>by Chios.
        </div>
    </div>

    <script>
        for (let i = 1; i <= 10; i++) {
            document.getElementById('key' + i).addEventListener('input', function() {
                document.getElementById('installLink').style.display = 'none';
                document.getElementById('validateBtn').style.display = 'block';
                document.getElementById('statusMsg').style.display = 'none';
                this.style.borderColor = "#333333";
            });
        }

        async function validateKeys() {
            const validateBtn = document.getElementById('validateBtn');
            const installLink = document.getElementById('installLink');
            const statusMsg = document.getElementById('statusMsg');
            
            statusMsg.style.display = 'none';
            let keysArray = [];
            
            for (let i = 1; i <= 10; i++) {
                let input = document.getElementById('key' + i);
                let val = input.value.trim();
                input.style.borderColor = "#333333";
                
                if (val === "") {
                    statusMsg.innerText = `Eroare: Câmpul ${i} este obligatoriu.`;
                    statusMsg.style.display = 'block';
                    input.style.borderColor = "#ff3333";
                    input.focus();
                    return;
                }
                
                if (!val.startsWith("AIza") && !val.startsWith("AQ")) {
                    statusMsg.innerText = `Eroare: Format invalid la câmpul ${i}.`;
                    statusMsg.style.display = 'block';
                    input.style.borderColor = "#ff3333";
                    input.focus();
                    return;
                }
                
                keysArray.push({ id: 'key' + i, value: val });
            }

            validateBtn.innerText = "Se verifică pe rând... (așteaptă)";
            validateBtn.disabled = true;
            
            let allValid = true;

            for (let i = 0; i < keysArray.length; i++) {
                let keyObj = keysArray[i];
                let input = document.getElementById(keyObj.id);
                
                try {
                    await new Promise(r => setTimeout(r, 200)); 

                    let res = await fetch('/validate-key?key=' + encodeURIComponent(keyObj.value));
                    
                    if (!res.ok) {
                        input.style.borderColor = "#ff3333";
                        allValid = false;
                        continue;
                    }

                    let data = await res.json();
                    
                    if (data.valid === true) {
                        input.style.borderColor = "#00ff7f";
                    } else {
                        input.style.borderColor = "#ff3333";
                        allValid = false;
                    }
                } catch (e) {
                    input.style.borderColor = "#ff3333";
                    allValid = false;
                }
            }

            validateBtn.innerText = "Verifică Datele";
            validateBtn.disabled = false;

            if (allValid) {
                validateBtn.style.display = 'none';
                
                const configJson = JSON.stringify(keysArray.map(k => k.value));
                const base64Config = btoa(configJson);
                
                const currentUrl = window.location.href.replace('https://', '').replace('http://', '').split('/')[0];
                const installUrl = `stremio://${currentUrl}/${base64Config}/manifest.json`;
                
                installLink.href = installUrl;
                installLink.style.display = 'block';
            } else {
                statusMsg.innerText = "Eroare: Datele marcate cu roșu sunt greșite sau blocate!";
                statusMsg.style.display = 'block';
            }
        }
    </script>
</body>
</html>
