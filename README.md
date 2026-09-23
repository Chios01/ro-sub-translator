# 🎬 RO Sub Translator for Stremio (Powered by Gemini AI)

Un add-on de înaltă performanță pentru Stremio care traduce automat subtitrările din limba engleză în limba română folosind inteligența artificială (Google Gemini API). 

Acest proiect nu este doar un simplu script de traducere, ci un **motor robust, rezistent la erori și ultra-rapid**, conceput să gestioneze limitările API-urilor gratuite (Rate Limits) și să ofere o traducere impecabilă din punct de vedere gramatical.

### 🚀 Caracteristici Principale

* **Viteză Adaptivă & Mod Turbo (Multi-Threading):** Sistemul acționează ca o cutie de viteze automată. La configurarea standard (10 chei API), utilizează 3 "muncitori" asincroni care traduc simultan. Dacă introduci 20 de chei, activează automat Modul Turbo (5 muncitori simultani) care traduc simultan calupuri de câte 165 de linii.
* **Curățare Inteligentă (Anti-SDH):** Elimină automat descrierile de sunete și parantezele destinate persoanelor cu deficiențe de auz, lăsând pe ecran exclusiv dialogul curat al personajelor.
* **Sistem BYOK (Bring Your Own Key):** Complet descentralizat. Fiecare utilizator își introduce propriile chei (10 obligatorii, 10 opționale pentru Turbo) printr-o interfață web securizată, eliminând riscul de blocare globală a addon-ului.
* **Memorie Cache Globală:** Odată ce un film a fost tradus de un utilizator, fișierul `.srt` rămâne salvat în memoria RAM a serverului. Următorii utilizatori care accesează același film primesc traducerea instantaneu, cu 0 timp de așteptare și 0 consum de API.
* **Toleranță la Erori (Auto-Recuperare):** Dacă Google refuză o cheie (Eroarea 429 - Too Many Requests), serverul o trimite automat "pe bancă" la răcit pentru 60 de secunde, rotește următoarea cheie disponibilă și recuperează instant liniile omise.
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

## 🛠️ Tehnologii Folosite

* **Node.js & Express:** Pentru serverul backend și generarea manifestului Stremio.
* **Axios:** Pentru cererile HTTP rapide către serverele de subtitrări și Google API.
* **srt-parser-2:** Pentru parsarea precisă a blocurilor de text din fișierele `.srt`.
* **Gemini 3.5 Flash-Lite:** Modelul AI ales pentru raportul perfect între viteza de reacție și precizia contextuală.

## 💡 Cum funcționează magia? (Under the Hood)

Spre deosebire de alte addon-uri care dau crash la prima eroare Google, `ro-sub-translator` citește fișierul `.srt`, îl transformă într-un fișier JSON ordonat și îl împarte în bucăți chirurgicale de câte 165 de linii. 

Dacă Google blochează o cerere (Timeout de 120s sau limită de trafic), serverul nu abandonează. Calmează IP-ul pentru 1.5 - 10 secunde, schimbă cheia API și atacă din nou problema până când 100% din subtitrare este extrasă corect și asamblată perfect sincronizat pe ecran.

---
*Proiect creat din pasiune pentru filme și cod curat. 🎬🤖*
