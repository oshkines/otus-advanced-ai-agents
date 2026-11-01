#pragma once

// ============================================================================
//  NotificationRouter - маршрутизация уведомлений ядра AI Dev Orchestrator.
//
//  Источник данных: блок "notification_channels" из config/orchestrator.json
//
//    "notification_channels": {
//      "telegram": { "enabled": true, "webhook_url": "ENV_TELEGRAM_WEBHOOK_URL",
//                    "work_hours_only": { "enabled": false, "start": "09:00",
//                                         "end": "18:00", "timezone": "Europe/Moscow" } },
//      "vk_max":   { "enabled": true, "webhook_url": "ENV_VK_MAX_URL",
//                    "work_hours_only": { "start": "09:00", "end": "18:00",
//                                         "timezone": "Europe/Moscow" } }  // окно включено
//    }
//
//    Объект work_hours_only без ключа "enabled" означает включённое окно -
//    значения start/end при этом обязательны (как в vk_max).
//
//  Контракт:
//    * значения вида "ENV_*" - имена переменных окружения Windows; секреты в
//      конфиге не хранятся и в логи не попадают;
//    * окно work_hours_only трактуется как [start, end) по московскому времени
//      (Europe/Moscow); часы считаются через <chrono> (tzdb, fallback UTC+3);
//    * транспорт доставки внедряется снаружи (Transport), поэтому класс не
//      зависит от HTTP-библиотеки и тестируется без сети. Штатный транспорт -
//      запуск agents/vk_max_sender.py или agents/telegram_sender.py, аргументы
//      для менеджера процессов готовит build_sender_argv().
//
//  Сборка: MSVC 2022, /std:c++20 /utf-8 (в исходнике есть кириллица).
// ============================================================================

#include <chrono>
#include <cstddef>
#include <filesystem>
#include <functional>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace orchestrator {

/// Каналы уведомлений, поддерживаемые конфигом (notification_channels.*).
enum class ChannelKind { telegram, vk_max };

/// Имя канала в терминах конфига ("telegram" / "vk_max").
[[nodiscard]] std::string_view to_string(ChannelKind kind) noexcept;

/// Обратное преобразование; std::nullopt для неизвестного канала.
[[nodiscard]] std::optional<ChannelKind> channel_from_string(std::string_view name) noexcept;

/// Ошибка чтения/валидации config/orchestrator.json.
class ConfigError : public std::runtime_error {
  public:
    explicit ConfigError(const std::string& message) : std::runtime_error(message) {}
};

/// Окно разрешённой доставки (work_hours_only).
struct WorkHoursWindow {
    bool enabled{false};
    std::chrono::minutes start{std::chrono::hours{9}};  ///< 09:00 по умолчанию
    std::chrono::minutes end{std::chrono::hours{18}};   ///< 18:00 по умолчанию
    std::string timezone{"Europe/Moscow"};

    /// true, если время суток попадает в окно [start, end); при start == end - круглые сутки.
    [[nodiscard]] bool contains(std::chrono::minutes local_time_of_day) const noexcept;
};

/// Нормализованный блок notification_channels.<channel>.
struct NotificationChannel {
    ChannelKind kind{ChannelKind::telegram};
    bool enabled{false};
    std::string webhook_url{};    ///< URL или имя переменной окружения (ENV_*)
    std::string sender_script{};  ///< agents/*_sender.py
    std::chrono::seconds timeout{15};
    WorkHoursWindow work_hours{};

    /// Развёрнутый URL: "ENV_VK_MAX_URL" -> значение из окружения; "" если не задано.
    [[nodiscard]] std::string resolved_webhook_url() const;

    /// true, если webhook_url задан и успешно развёрнут.
    [[nodiscard]] bool webhook_configured() const;
};

/// Результат проверки политики канала (и, опционально, вызова транспорта).
struct RoutingDecision {
    ChannelKind channel{ChannelKind::telegram};
    bool allowed{false};                  ///< политика разрешает отправку сейчас
    std::string reason{"not_evaluated"};  ///< ok / channel_disabled / outside_work_hours / ...
    std::chrono::system_clock::time_point checked_at{};
    std::chrono::minutes moscow_time_of_day{0};  ///< время суток в Москве на момент проверки
    bool transport_called{false};
    int transport_exit_code{0};

    [[nodiscard]] bool delivered() const noexcept { return transport_called && transport_exit_code == 0; }
};

/// Маршрутизатор уведомлений: парсит конфиг и проверяет окно рабочих часов.
class NotificationRouter {
  public:
    using TimePoint = std::chrono::system_clock::time_point;
    /// Транспорт доставки: код выхода (0 - успех), например код agents/*_sender.py.
    using Transport = std::function<int(const NotificationChannel& channel, std::string_view text)>;

    NotificationRouter() = default;

    /// Разбирает JSON-документ конфига (UTF-8, BOM допускается).
    /// @throws ConfigError при синтаксической или схемной ошибке.
    [[nodiscard]] static NotificationRouter from_json(std::string_view json_text);

    /// Читает конфиг с диска (BOM снимается).
    /// @throws ConfigError если файл недоступен или невалиден.
    [[nodiscard]] static NotificationRouter from_file(const std::filesystem::path& config_path);

    [[nodiscard]] bool has_channel(ChannelKind kind) const noexcept;
    /// @throws ConfigError если канал отсутствует в конфиге.
    [[nodiscard]] const NotificationChannel& channel(ChannelKind kind) const;
    [[nodiscard]] const std::vector<NotificationChannel>& channels() const noexcept { return channels_; }
    [[nodiscard]] std::size_t size() const noexcept { return channels_.size(); }

    /// true, если канал не ограничен часами или московское время попадает в окно.
    [[nodiscard]] bool is_within_work_hours(ChannelKind kind, TimePoint now_utc) const;

    /// Проверяет политику канала на момент now_utc (по умолчанию - сейчас).
    [[nodiscard]] RoutingDecision evaluate(ChannelKind kind,
                                           TimePoint now_utc = std::chrono::system_clock::now()) const;

    /// Проверяет политику и, если разрешено, вызывает транспорт.
    /// Для telegram окно отключено в конфиге -> доставка круглосуточная;
    /// для vk_max вне 09:00-18:00 МСК транспорт не вызывается (reason = outside_work_hours).
    RoutingDecision dispatch(ChannelKind kind, std::string_view text, const Transport& transport,
                            TimePoint now_utc = std::chrono::system_clock::now()) const;

    /// Аргументы запуска sender-скрипта канала: {sender_script, text}.
    [[nodiscard]] std::vector<std::string> build_sender_argv(ChannelKind kind, std::string_view text) const;

    /// Время суток в Москве (минуты от полуночи) для произвольного UTC-момента.
    /// Использует tzdb ("Europe/Moscow") через <chrono>, при недоступности tzdb - UTC+3.
    [[nodiscard]] static std::chrono::minutes moscow_time_of_day(TimePoint now_utc);

  private:
    std::vector<NotificationChannel> channels_{};
};

/// Однострочное описание решения для логов ядра.
[[nodiscard]] std::string describe(const RoutingDecision& decision);

}  // namespace orchestrator

