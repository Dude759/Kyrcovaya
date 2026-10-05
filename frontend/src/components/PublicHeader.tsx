import { Link, NavLink } from "react-router-dom";
import { BrandMark } from "./BrandMark";

export function PublicHeader() {
  return (
    <header className="public-header">
      <Link className="wordmark" to="/" aria-label="Энерготранспорт — главная">
        <BrandMark />
        <span>Энерготранспорт</span>
      </Link>
      <nav className="public-nav" aria-label="Основная навигация">
        <NavLink to="/driver/stations">Для водителей</NavLink>
        <NavLink to="/login?role=operator">Для операторов</NavLink>
        <Link to="/#about">О платформе</Link>
      </nav>
      <div className="public-actions">
        <Link className="text-link" to="/login">
          Войти
        </Link>
        <Link className="button button--dark button--small" to="/register">
          Регистрация
        </Link>
      </div>
    </header>
  );
}
