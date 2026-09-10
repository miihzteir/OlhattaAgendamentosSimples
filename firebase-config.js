// ============================================================
// CONFIGURAÇÃO DO FIREBASE
// ============================================================
// Troque os valores abaixo pelos dados do SEU projeto Firebase.
// Veja o passo a passo completo no arquivo LEIAME.md
// (Console do Firebase > Configurações do projeto > Seus apps > Config)
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyDwdZOeYIBJMZ_fTkyVJ-FI8PFpz_4KrME",
  authDomain: "olhattaagendamentossimples.firebaseapp.com",
  projectId: "olhattaagendamentossimples",
  storageBucket: "olhattaagendamentossimples.firebasestorage.app",
  messagingSenderId: "382113487409",
  appId: "1:382113487409:web:6fea56c3970ba45dc71310"
};

// E-mails que podem acessar o sistema (tem que bater com o firestore.rules também)
const EMAILS_PERMITIDOS = [
  "francimeryapfachini@gmail.com",
  "draoftalmologistavet@gmail.com",
  "miihrietz@gmail.com",
  "miihzteir@gmail.com"
];
