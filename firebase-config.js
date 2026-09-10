// ============================================================
// CONFIGURAÇÃO DO FIREBASE
// ============================================================
// Troque os valores abaixo pelos dados do SEU projeto Firebase.
// Veja o passo a passo completo no arquivo LEIAME.md
// (Console do Firebase > Configurações do projeto > Seus apps > Config)
// ============================================================

const firebaseConfig = {
  apiKey: "COLE_AQUI",
  authDomain: "COLE_AQUI.firebaseapp.com",
  projectId: "COLE_AQUI",
  storageBucket: "COLE_AQUI.appspot.com",
  messagingSenderId: "COLE_AQUI",
  appId: "COLE_AQUI"
};

// E-mails que podem acessar o sistema (tem que bater com o firestore.rules também)
const EMAILS_PERMITIDOS = [
  "francimeryapfachini@gmail.com",
  "draoftalmologistavet@gmail.com",
  "miihrietz@gmail.com",
  "miihzteir@gmail.com"
];
