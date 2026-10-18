import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

// 팝업 진입점: #app 에 마운트한다.
const app = mount(App, { target: document.getElementById('app')! })

export default app
