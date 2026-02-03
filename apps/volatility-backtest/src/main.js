import { createApp } from "vue";
import App from "./App.vue";
import "../../../lib/styles.css";
import "./styles.css";

const el = document.getElementById("app");
if (el && !el.querySelector(".app")) {
  createApp(App).mount("#app");
}
