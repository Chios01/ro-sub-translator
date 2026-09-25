# 🎬 RO Sub Translator for Stremio (Powered by Gemini AI)

Un add-on de înaltă performanță pentru Stremio care traduce automat subtitrările din limba engleză în limba română folosind inteligența artificială (Google Gemini API). 

Acest proiect nu este doar un simplu script de traducere, ci un **motor robust, rezistent la erori și ultra-rapid**, conceput să gestioneze limitările API-urilor gratuite (Rate Limits) și să ofere o traducere impecabilă din punct de vedere gramatical.

## ✨ Funcționalități Cheie

* 🚀 **Viteză Extremă (Multi-Threading):** Utilizează un sistem asincron cu 3 "muncitori" (concurrency limit) care traduc simultan calupuri de câte 165 de linii.
* 🛡️ **Arhitectură "Antiglonț" (Auto-Healing & Retry):** 
  * Detectează automat erorile **HTTP 429 (Too Many Requests)** și **HTTP 503 (Service Unavailable)**.
  * Pune automat cheile API epuizate "pe bancă" (cooldown) și rotește rapid o altă cheie din sistem.
  * Dacă AI-ul omite linii din cauza limitelor de tokeni, sistemul prinde eroarea din zbor și recuperează doar liniile lipsă, fără a opri filmul.
* 🧠 **Gramatică și "Fine-Tuning" Avansat:** Prompt-ul către Gemini (`gemini-3.5-flash-lite`) este optimizat la sânge pentru limba română:
  * Elimină automat zgomotele de fundal și interjecțiile inutile (*"uh", "mhm", "aha"*).
  * Interzice traducerile literale ale expresiilor idiomatice (idioms).
  * Curăță slang-ul englezesc lăsat accidental de AI (*"man", "bro", "dude"*).
  * Corectează acordurile de gen, număr și utilizarea cratimelor.
* 🔑 **Sistem Multi-Key (Optimizat pentru 10 chei):** Addon-ul funcționează cel mai bine folosind un "pool" extins de chei API pentru a distribui traficul. **Pentru ca motorul să ruleze la parametri optimi, fără blocaje sau întreruperi, este necesară introducerea a 10 chei API.** Cheile pot fi generate complet gratuit accesând platforma oficială [Google AI Studio](https://aistudio.google.com/app/apikey).

## 🌐 Interfața Web de Instalare și Validare

Add-on-ul vine cu o pagină de configurare modernă (optimizată atât pentru PC, cât și pentru mobil), gândită special pentru a preveni orice eroare umană la instalare. 

### ✨ Funcționalități cheie ale interfeței:
* **Validare Live (Anti-Eroare):** Înainte de instalare, interfața comunică direct cu serverele Google pentru a verifica autenticitatea cheilor tale.
* **Feedback Vizual Individual:** Cheile corecte se vor colora în **verde**, iar dacă ai copiat greșit sau incomplet o cheie, căsuța respectivă se va face **roșie**. Știi exact unde trebuie să corectezi!
* **Securitate:** Datele tale sunt împachetate în siguranță (Base64) și trimise direct către aplicația ta Stremio.

### ⚠️ REGULĂ STRICTĂ: Ai nevoie de EXACT 10 chei API!
Pentru ca sistemul avansat de Anti-Cenzură și Anti-Spam (rotația cheilor) să funcționeze impecabil și să traducă mii de linii în câteva secunde, **este obligatoriu să introduci 10 chei API Google Gemini (care încep cu `AIza...` sau `AQ...`)**. 

Dacă lași o căsuță goală sau dacă o cheie este invalidă, butonul final de instalare va rămâne ascuns.

### 🛠️ Cum se instalează:
1. Generează gratuit cele 10 chei API Gemini din Google AI Studio.
2. Lipește-le cu atenție în cele 10 căsuțe de pe pagina de configurare a add-on-ului.
3. Apasă butonul mov **„Verifică Cheile”** și așteaptă câteva secunde.
4. Doar după ce **toate cele 10 căsuțe devin verzi**, va apărea butonul verde **„Instalează în Stremio”**.
5. Apasă-l și bucură-te de filmele tale preferate! 🍿

## 🛠️ Tehnologii Folosite

* **Node.js & Express:** Pentru serverul backend și generarea manifestului Stremio.
* **Axios:** Pentru cererile HTTP rapide către serverele de subtitrări și Google API.
* **srt-parser-2:** Pentru parsarea precisă a blocurilor de text din fișierele `.srt`.
* **Gemini 3.5 Flash-Lite:** Modelul AI ales pentru raportul perfect între viteza de reacție și precizia contextuală.

## 💡 Cum funcționează magia? (Under the Hood)

Spre deosebire de alte addon-uri care dau crash la prima eroare Google, `ro-sub-translator` citește fișierul `.srt`, îl transformă într-un fișier JSON ordonat și îl împarte în bucăți chirurgicale de câte 165 de linii. 

Dacă Google blochează o cerere (Timeout de 120s sau limită de trafic), serverul nu abandonează. Calmează IP-ul pentru 1.5 - 10 secunde, schimbă cheia API și atacă din nou problema până când 100% din subtitrare este extrasă corect și asamblată perfect sincronizat pe ecran.
---
## ⚠️ Disclaimer & Legal

Acest addon este un proiect open-source creat exclusiv în scop educativ și pentru a ajuta comunitatea. 

* **Utilizarea API-ului:** Addon-ul necesită folosirea unor chei API Google Gemini personale. Tu ești singurul responsabil pentru gestionarea, securitatea și limitele de utilizare ale acestor chei.
* **Fără afiliere:** Acest proiect **nu** este afiliat, asociat, autorizat, susținut sau aprobat în niciun fel de Google, Alphabet Inc. sau Stremio.
* **Limitarea Răspunderii:** Dezvoltatorul nu își asumă nicio responsabilitate pentru funcționarea întreruptă a serviciilor, eventualele costuri survenite din utilizarea API-ului, limitările de trafic (rate limits) sau blocarea/suspendarea cheilor tale API. Utilizezi acest software pe propriul risc („as is”).

## 📄 Licență

Acest proiect este licențiat sub **Licența MIT** - așadar ești liber să îl folosești, modifici și distribui, cu respectarea clauzelor de limitare a răspunderii. Citește fișierul `LICENSE` pentru mai multe detalii.
---
*Proiect creat din pasiune pentru filme și cod curat. 🎬🤖*
