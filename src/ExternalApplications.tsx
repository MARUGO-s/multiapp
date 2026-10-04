import {
  ArrowRight,
  BookOpen,
  FileText,
  Landmark,
  MessageCircle,
  NotebookPen,
  Share2,
  Star,
} from "lucide-react";
import { applicationLinks } from "./application-links.mjs";

const icons: Record<string, typeof FileText> = {
  report: FileText,
  recipe: BookOpen,
  management: Landmark,
  chat: MessageCircle,
  journal: NotebookPen,
  gourmet: Star,
  sns: Share2,
};

export function ExternalApplications() {
  return (
    <nav
      className="external-applications"
      aria-labelledby="external-applications-title"
    >
      <h2 id="external-applications-title">ほかのアプリを開く</h2>
      <p>ボタンを押すと各アプリへ移動します。</p>
      <div className="external-application-grid">
        {applicationLinks.map(({ id, name, note, icon, href }) => {
          const Icon = icons[icon];
          return (
            <a
              className="application-option external-application"
              key={id}
              href={href}
            >
              <Icon size={25} aria-hidden="true" />
              <span>
                <strong>{name}</strong>
                <small>{note}</small>
              </span>
              <ArrowRight size={18} aria-hidden="true" />
            </a>
          );
        })}
      </div>
      <p>
        <a href={import.meta.env.BASE_URL + "?admin=users"}>
          登録ユーザー管理（管理者専用）
        </a>
      </p>
    </nav>
  );
}
