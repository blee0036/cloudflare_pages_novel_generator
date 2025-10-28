import { Link } from "react-router-dom";

const NotFoundPage: React.FC = () => (
  <section className="panel">
    <div className="empty-state">
      <h2 style={{ marginTop: 0 }}>页面不存在</h2>
      <p>抱歉，您访问的页面不存在或已被移除。</p>
      <Link className="book-link" to="/">
        返回书库
      </Link>
    </div>
  </section>
);

export default NotFoundPage;
