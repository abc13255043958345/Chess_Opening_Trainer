import { NavLink, Route, Routes } from "react-router-dom";
import Home from "./screens/Home";
import Catalog from "./screens/Catalog";
import OpeningView from "./screens/OpeningView";
import Editor from "./screens/Editor";
import Practice from "./screens/Practice";
import Explorer from "./screens/Explorer";

export default function App() {
  return (
    <div className="app">
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/catalog" element={<Catalog />} />
          <Route path="/opening/:id" element={<OpeningView />} />
          <Route path="/edit/:id" element={<Editor />} />
          <Route path="/practice" element={<Practice />} />
          <Route path="/explorer" element={<Explorer />} />
        </Routes>
      </main>
      <nav className="bottom-nav">
        <NavLink to="/" end>
          Home
        </NavLink>
        <NavLink to="/catalog">Openings</NavLink>
        <NavLink to="/practice">Practice</NavLink>
        <NavLink to="/explorer">Explorer</NavLink>
      </nav>
    </div>
  );
}
