#include "notification_router.h"

#include <algorithm>
#include <charconv>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <sstream>
#include <utility>

namespace orchestrator {
namespace {

// ---------------------------------------------------------------------------
//  Минимальный JSON-парсер.
//
//  Проект не подключает сторонние C++-библиотеки (vcpkg-зависимостей пока нет),
//  а конфиг маленький, поэтому реализован компактный разборщик JSON (RFC 8259):
//  объекты, массивы, строки (с \uXXXX и суррогатными парами), числа, bool, null.
// ---------------------------------------------------------------------------

/// Синтаксическая ошибка конфига (наследник ConfigError - ловится одним catch).
class ParseError : public ConfigError {
  public:
    explicit ParseError(const std::string& message) : ConfigError("JSON parse error: " + message) {}
};

struct JsonValue;

/// JSON-объект: ключи и значения в параллельных векторах (порядок сохраняется).
/// std::vector допускает незавершённый тип, поэтому рекурсия по значению легальна.
struct JsonObject {
    std::vector<std::string> keys;
    std::vector<JsonValue> values;
};

struct JsonValue {
    enum class Type { null_value, boolean, number, string, array, object };

    Type type{Type::null_value};
    bool boolean{false};
    double number{0.0};
    std::string text{};
    std::vector<JsonValue> items{};
    JsonObject object{};

    /// Поиск поля; nullptr, если узел не объект или ключа нет.
    [[nodiscard]] const JsonValue* find(std::string_view key) const {
        if (type != Type::object) return nullptr;
        for (std::size_t index = 0; index < object.keys.size(); ++index) {
            if (object.keys[index] == key) return &object.values[index];
        }
        return nullptr;
    }
};

/// Рекурсивный разборщик JSON с позицией для информативных сообщений об ошибках.
class JsonParser {
  public:
    explicit JsonParser(std::string_view text) : text_(text) {}

    [[nodiscard]] JsonValue parse_document();

  private:
    std::string_view text_;
    std::size_t position_{0};

    [[nodiscard]] bool eof() const noexcept { return position_ >= text_.size(); }
    [[nodiscard]] char peek() const { return text_[position_]; }

    void skip_whitespace() noexcept;
    char take();
    void expect(char symbol);
    void expect_literal(std::string_view literal);

    [[nodiscard]] JsonValue parse_value();
    [[nodiscard]] JsonValue parse_object();
    [[nodiscard]] JsonValue parse_array();
    [[nodiscard]] std::string parse_string();
    [[nodiscard]] char32_t parse_hex4();
    [[nodiscard]] char32_t parse_unicode_escape();
    [[nodiscard]] double parse_number();

    static void append_utf8(std::string& target, char32_t code_point);
    [[nodiscard]] static JsonValue make_string(std::string value);
    [[nodiscard]] static JsonValue make_number(double value);
    [[nodiscard]] static JsonValue make_boolean(bool value);
};

}  // namespace
}  // namespace orchestrator

namespace orchestrator {
namespace {

JsonValue JsonParser::parse_document() {
    skip_whitespace();
    JsonValue value = parse_value();
    skip_whitespace();
    if (!eof()) {
        throw ParseError("unexpected trailing characters at offset " + std::to_string(position_));
    }
    return value;
}

void JsonParser::skip_whitespace() noexcept {
    while (!eof()) {
        const char symbol = peek();
        if (symbol != ' ' && symbol != '\t' && symbol != '\n' && symbol != '\r') break;
        ++position_;
    }
}

char JsonParser::take() {
    if (eof()) throw ParseError("unexpected end of input");
    return text_[position_++];
}

void JsonParser::expect(char symbol) {
    if (eof() || peek() != symbol) {
        throw ParseError(std::string{"expected '"} + symbol + "' at offset " + std::to_string(position_));
    }
    ++position_;
}

void JsonParser::expect_literal(std::string_view literal) {
    if (text_.substr(position_, literal.size()) != literal) {
        throw ParseError("invalid literal at offset " + std::to_string(position_));
    }
    position_ += literal.size();
}

JsonValue JsonParser::parse_value() {
    skip_whitespace();
    if (eof()) throw ParseError("unexpected end of input");
    switch (peek()) {
        case '{': return parse_object();
        case '[': return parse_array();
        case '"': return make_string(parse_string());
        case 't':
            expect_literal("true");
            return make_boolean(true);
        case 'f':
            expect_literal("false");
            return make_boolean(false);
        case 'n':
            expect_literal("null");
            return JsonValue{};
        default: return make_number(parse_number());
    }
}

JsonValue JsonParser::parse_object() {
    expect('{');
    JsonValue node;
    node.type = JsonValue::Type::object;
    skip_whitespace();
    if (!eof() && peek() == '}') {
        ++position_;
        return node;
    }
    while (true) {
        skip_whitespace();
        if (eof() || peek() != '"') {
            throw ParseError("expected object key at offset " + std::to_string(position_));
        }
        std::string key = parse_string();
        skip_whitespace();
        expect(':');
        JsonValue value = parse_value();
        node.object.keys.push_back(std::move(key));
        node.object.values.push_back(std::move(value));
        skip_whitespace();
        if (eof()) throw ParseError("unterminated object");
        const char separator = take();
        if (separator == '}') break;
        if (separator != ',') {
            throw ParseError("expected ',' or '}' in object at offset " + std::to_string(position_));
        }
    }
    return node;
}

JsonValue JsonParser::parse_array() {
    expect('[');
    JsonValue node;
    node.type = JsonValue::Type::array;
    skip_whitespace();
    if (!eof() && peek() == ']') {
        ++position_;
        return node;
    }
    while (true) {
        node.items.push_back(parse_value());
        skip_whitespace();
        if (eof()) throw ParseError("unterminated array");
        const char separator = take();
        if (separator == ']') break;
        if (separator != ',') {
            throw ParseError("expected ',' or ']' in array at offset " + std::to_string(position_));
        }
    }
    return node;
}

std::string JsonParser::parse_string() {
    expect('"');
    std::string result;
    while (true) {
        if (eof()) throw ParseError("unterminated string");
        const char symbol = take();
        if (symbol == '"') break;
        if (symbol != '\\') {
            if (static_cast<unsigned char>(symbol) < 0x20U) {
                throw ParseError("control character in string at offset " + std::to_string(position_));
            }
            result.push_back(symbol);
            continue;
        }
        const char escape = take();
        switch (escape) {
            case '"': result.push_back('"'); break;
            case '\\': result.push_back('\\'); break;
            case '/': result.push_back('/'); break;
            case 'b': result.push_back('\b'); break;
            case 'f': result.push_back('\f'); break;
            case 'n': result.push_back('\n'); break;
            case 'r': result.push_back('\r'); break;
            case 't': result.push_back('\t'); break;
            case 'u': append_utf8(result, parse_unicode_escape()); break;
            default: throw ParseError(std::string{"invalid escape sequence '\\"} + escape + "'");
        }
    }
    return result;
}

char32_t JsonParser::parse_hex4() {
    char32_t value = 0;
    for (int index = 0; index < 4; ++index) {
        if (eof()) throw ParseError("truncated \\u escape");
        const char symbol = take();
        value <<= 4U;
        if (symbol >= '0' && symbol <= '9') {
            value += static_cast<char32_t>(symbol - '0');
        } else if (symbol >= 'a' && symbol <= 'f') {
            value += static_cast<char32_t>(symbol - 'a' + 10);
        } else if (symbol >= 'A' && symbol <= 'F') {
            value += static_cast<char32_t>(symbol - 'A' + 10);
        } else {
            throw ParseError("invalid hex digit in \\u escape");
        }
    }
    return value;
}

char32_t JsonParser::parse_unicode_escape() {
    constexpr char32_t high_surrogate_min = 0xD800;
    constexpr char32_t high_surrogate_max = 0xDBFF;
    constexpr char32_t low_surrogate_min = 0xDC00;
    constexpr char32_t low_surrogate_max = 0xDFFF;

    char32_t code_point = parse_hex4();
    if (code_point >= high_surrogate_min && code_point <= high_surrogate_max) {
        if (text_.substr(position_, 2) != "\\u") throw ParseError("missing low surrogate after \\u escape");
        position_ += 2;
        const char32_t low = parse_hex4();
        if (low < low_surrogate_min || low > low_surrogate_max) throw ParseError("invalid low surrogate");
        code_point = 0x10000 + ((code_point - high_surrogate_min) << 10U) + (low - low_surrogate_min);
    } else if (code_point >= low_surrogate_min && code_point <= low_surrogate_max) {
        throw ParseError("unexpected low surrogate");
    }
    return code_point;
}

void JsonParser::append_utf8(std::string& target, char32_t code_point) {
    if (code_point <= 0x7F) {
        target.push_back(static_cast<char>(code_point));
    } else if (code_point <= 0x7FF) {
        target.push_back(static_cast<char>(0xC0 | ((code_point >> 6U) & 0x1F)));
        target.push_back(static_cast<char>(0x80 | (code_point & 0x3F)));
    } else if (code_point <= 0xFFFF) {
        target.push_back(static_cast<char>(0xE0 | ((code_point >> 12U) & 0x0F)));
        target.push_back(static_cast<char>(0x80 | ((code_point >> 6U) & 0x3F)));
        target.push_back(static_cast<char>(0x80 | (code_point & 0x3F)));
    } else {
        target.push_back(static_cast<char>(0xF0 | ((code_point >> 18U) & 0x07)));
        target.push_back(static_cast<char>(0x80 | ((code_point >> 12U) & 0x3F)));
        target.push_back(static_cast<char>(0x80 | ((code_point >> 6U) & 0x3F)));
        target.push_back(static_cast<char>(0x80 | (code_point & 0x3F)));
    }
}

double JsonParser::parse_number() {
    const std::size_t start = position_;
    while (!eof()) {
        const char symbol = peek();
        const bool number_char = (symbol >= '0' && symbol <= '9') || symbol == '-' || symbol == '+' ||
                                 symbol == '.' || symbol == 'e' || symbol == 'E';
        if (!number_char) break;
        ++position_;
    }
    if (start == position_) {
        throw ParseError("unexpected character at offset " + std::to_string(position_));
    }
    const std::string literal{text_.substr(start, position_ - start)};
    try {
        std::size_t processed = 0;
        const double value = std::stod(literal, &processed);
        if (processed != literal.size()) throw ParseError("invalid number literal '" + literal + "'");
        return value;
    } catch (const std::invalid_argument&) {
        throw ParseError("invalid number literal '" + literal + "'");
    } catch (const std::out_of_range&) {
        throw ParseError("number out of range '" + literal + "'");
    }
}

JsonValue JsonParser::make_string(std::string value) {
    JsonValue node;
    node.type = JsonValue::Type::string;
    node.text = std::move(value);
    return node;
}

JsonValue JsonParser::make_number(double value) {
    JsonValue node;
    node.type = JsonValue::Type::number;
    node.number = value;
    return node;
}

JsonValue JsonParser::make_boolean(bool value) {
    JsonValue node;
    node.type = JsonValue::Type::boolean;
    node.boolean = value;
    return node;
}

}  // namespace
}  // namespace orchestrator

namespace orchestrator {
namespace {

// ---------------------------------------------------------------------------
//  Хелперы чтения и валидации конфига
// ---------------------------------------------------------------------------

/// Склеивает путь поля для сообщений об ошибках: "a.b" + "c" -> "a.b.c".
[[nodiscard]] std::string join_path(std::string_view base, std::string_view suffix) {
    std::string result{base};
    if (!result.empty() && !suffix.empty()) result.push_back('.');
    result.append(suffix);
    return result;
}

/// Значение переменной окружения Windows или "" (секреты в конфиге не хранятся).
[[nodiscard]] std::string environment_value(std::string_view name) {
    if (name.empty()) return {};
    const std::string key{name};
#if defined(_MSC_VER)
    // MSVC помечает getenv как небезопасный (C4996) - используем безопасный вариант.
    char* buffer = nullptr;
    std::size_t length = 0;
    if (_dupenv_s(&buffer, &length, key.c_str()) != 0 || buffer == nullptr) return {};
    const std::string raw_value{buffer};
    std::free(buffer);
#else
    const char* raw = std::getenv(key.c_str());
    if (raw == nullptr) return {};
    const std::string raw_value{raw};
#endif
    const std::size_t first = raw_value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return {};
    const std::size_t last = raw_value.find_last_not_of(" \t\r\n");
    return raw_value.substr(first, last - first + 1);
}

/// Разворачивает значение конфига: "ENV_NAME" -> окружение, литерал -> как есть.
[[nodiscard]] std::string resolve_env(std::string_view value) {
    const std::string_view prefix{"ENV_"};
    if (value.substr(0, prefix.size()) != prefix) return std::string{value};
    return environment_value(value);
}

/// Строковое поле объекта; отсутствие/null -> fallback, другой тип -> ConfigError.
[[nodiscard]] std::string string_field(const JsonValue& node, std::string_view key, std::string fallback,
                                       std::string_view path) {
    const JsonValue* field = node.find(key);
    if (field == nullptr || field->type == JsonValue::Type::null_value) return fallback;
    if (field->type != JsonValue::Type::string) {
        throw ConfigError(join_path(path, key) + " must be a string");
    }
    return field->text;
}

/// Логическое поле объекта; отсутствие/null -> fallback, другой тип -> ConfigError.
[[nodiscard]] bool bool_field(const JsonValue& node, std::string_view key, bool fallback, std::string_view path) {
    const JsonValue* field = node.find(key);
    if (field == nullptr || field->type == JsonValue::Type::null_value) return fallback;
    if (field->type != JsonValue::Type::boolean) {
        throw ConfigError(join_path(path, key) + " must be a boolean");
    }
    return field->boolean;
}

/// Разбирает "HH:MM" в минуты от полуночи; диапазон 00:00..23:59.
[[nodiscard]] std::chrono::minutes parse_hh_mm(std::string_view value, std::string_view path) {
    const std::string text{value};
    const auto invalid = [&]() {
        return ConfigError(join_path(path, "") + "invalid time value '" + text + "', expected HH:MM");
    };

    const std::size_t colon = text.find(':');
    if (colon == std::string::npos || text.find(':', colon + 1) != std::string::npos) throw invalid();

    const std::string_view hours_text{text.data(), colon};
    const std::string_view minutes_text{text.data() + colon + 1, text.size() - colon - 1};
    if (hours_text.empty() || hours_text.size() > 2 || minutes_text.empty() || minutes_text.size() > 2) throw invalid();

    int hours = 0;
    int minutes = 0;
    const auto [hours_end, hours_error] =
        std::from_chars(hours_text.data(), hours_text.data() + hours_text.size(), hours);
    if (hours_error != std::errc{} || hours_end != hours_text.data() + hours_text.size()) throw invalid();
    const auto [minutes_end, minutes_error] =
        std::from_chars(minutes_text.data(), minutes_text.data() + minutes_text.size(), minutes);
    if (minutes_error != std::errc{} || minutes_end != minutes_text.data() + minutes_text.size()) throw invalid();
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
        throw ConfigError(join_path(path, "") + "time value out of range: '" + text + "'");
    }
    return std::chrono::minutes{hours * 60 + minutes};
}

/// Форматирует минуты от полуночи как "HH:MM" (значение нормализуется по суткам).
[[nodiscard]] std::string format_hh_mm(std::chrono::minutes value) {
    const long long raw = value.count() % 1440;
    const long long total = raw < 0 ? raw + 1440 : raw;
    std::ostringstream out;
    out << std::setfill('0') << std::setw(2) << (total / 60) << ':' << std::setw(2) << (total % 60);
    return out.str();
}

/// Читает `timeout_sec` (секунды, положительное число).
[[nodiscard]] std::chrono::seconds read_timeout(const JsonValue& node, std::string_view path) {
    const JsonValue* field = node.find("timeout_sec");
    if (field == nullptr || field->type == JsonValue::Type::null_value) return std::chrono::seconds{15};
    if (field->type != JsonValue::Type::number) {
        throw ConfigError(join_path(path, "timeout_sec") + " must be a number");
    }
    if (!(field->number > 0.0)) {
        throw ConfigError(join_path(path, "timeout_sec") + " must be positive");
    }
    return std::chrono::seconds{static_cast<long long>(field->number)};
}

/// Разбирает `work_hours_only` (объект, boolean или отсутствие).
[[nodiscard]] WorkHoursWindow read_work_hours(const JsonValue* raw, std::string_view path) {
    WorkHoursWindow window;
    if (raw == nullptr || raw->type == JsonValue::Type::null_value) return window;
    if (raw->type == JsonValue::Type::boolean) {
        window.enabled = raw->boolean;
        return window;
    }
    if (raw->type != JsonValue::Type::object) {
        throw ConfigError(std::string{path} + " must be an object or boolean");
    }
    // Как и в agents/notification_channels.py: при наличии объекта окно включено,
    // если явно не указано "enabled": false.
    window.enabled = bool_field(*raw, "enabled", true, path);
    window.start =
        parse_hh_mm(string_field(*raw, "start", format_hh_mm(window.start), path), join_path(path, "start"));
    window.end = parse_hh_mm(string_field(*raw, "end", format_hh_mm(window.end), path), join_path(path, "end"));
    window.timezone = string_field(*raw, "timezone", window.timezone, path);
    // Ядро считает окно только по Москве (UTC+3, без перехода на летнее время).
    if (window.timezone != "Europe/Moscow" && window.timezone != "MSK" && window.timezone != "UTC+3") {
        throw ConfigError(join_path(path, "timezone") + ": only Europe/Moscow (UTC+3) is supported, got '" +
                          window.timezone + "'");
    }
    return window;
}

/// Разбирает один канал `notification_channels.<name>`.
[[nodiscard]] NotificationChannel read_channel(std::string_view name, const JsonValue& block) {
    const std::optional<ChannelKind> kind = channel_from_string(name);
    if (!kind.has_value()) {
        throw ConfigError("unknown notification channel '" + std::string{name} + "'");
    }
    const std::string path = "notification_channels." + std::string{name};
    if (block.type != JsonValue::Type::object) throw ConfigError(path + " must be an object");

    NotificationChannel channel;
    channel.kind = *kind;
    channel.enabled = bool_field(block, "enabled", false, path);
    channel.webhook_url = string_field(block, "webhook_url", "", path);
    channel.sender_script = string_field(block, "sender_script", "", path);
    channel.timeout = read_timeout(block, path);
    channel.work_hours = read_work_hours(block.find("work_hours_only"), join_path(path, "work_hours_only"));
    return channel;
}

/// Снимает BOM UTF-8 в начале документа (config/orchestrator.json может быть с BOM).
[[nodiscard]] std::string_view strip_bom(std::string_view text) {
    if (text.size() >= 3 && static_cast<unsigned char>(text[0]) == 0xEF &&
        static_cast<unsigned char>(text[1]) == 0xBB && static_cast<unsigned char>(text[2]) == 0xBF) {
        return text.substr(3);
    }
    return text;
}

/// Время суток в Москве: tzdb через <chrono>, при её отсутствии - фиксированный UTC+3.
[[nodiscard]] std::chrono::minutes moscow_time_of_day_impl(std::chrono::system_clock::time_point now_utc) {
#if defined(__cpp_lib_chrono) && __cpp_lib_chrono >= 201907L
    try {
        const std::chrono::time_zone* zone = std::chrono::locate_zone("Europe/Moscow");
        const auto zoned = std::chrono::zoned_time<std::chrono::seconds>{
            zone, std::chrono::floor<std::chrono::seconds>(now_utc)};
        const auto local = zoned.get_local_time();
        const auto midnight = std::chrono::floor<std::chrono::days>(local);
        return std::chrono::duration_cast<std::chrono::minutes>(local - midnight);
    } catch (const std::exception&) {
        // База tzdata недоступна - ниже используется фиксированное смещение.
    }
#endif
    const auto moscow = now_utc + std::chrono::hours{3};
    const auto midnight = std::chrono::floor<std::chrono::days>(moscow);
    return std::chrono::duration_cast<std::chrono::minutes>(moscow - midnight);
}

}  // namespace
}  // namespace orchestrator

namespace orchestrator {

std::string_view to_string(ChannelKind kind) noexcept {
    switch (kind) {
        case ChannelKind::telegram: return "telegram";
        case ChannelKind::vk_max: return "vk_max";
    }
    return "unknown";
}

std::optional<ChannelKind> channel_from_string(std::string_view name) noexcept {
    if (name == "telegram") return ChannelKind::telegram;
    if (name == "vk_max") return ChannelKind::vk_max;
    return std::nullopt;
}

bool WorkHoursWindow::contains(std::chrono::minutes local_time_of_day) const noexcept {
    if (!enabled) return true;
    if (start == end) return true;  // окно нулевой длины трактуется как круглые сутки

    const long long raw = local_time_of_day.count() % 1440;
    const std::chrono::minutes current{raw < 0 ? raw + 1440 : raw};
    if (start < end) return current >= start && current < end;
    return current >= start || current < end;  // окно через полночь, например 22:00-06:00
}

std::string NotificationChannel::resolved_webhook_url() const {
    return resolve_env(webhook_url);
}

bool NotificationChannel::webhook_configured() const {
    return !resolved_webhook_url().empty();
}

NotificationRouter NotificationRouter::from_json(std::string_view json_text) {
    JsonParser parser{strip_bom(json_text)};
    const JsonValue root = parser.parse_document();
    if (root.type != JsonValue::Type::object) {
        throw ConfigError("config root must be a JSON object");
    }
    const JsonValue* channels = root.find("notification_channels");
    if (channels == nullptr || channels->type != JsonValue::Type::object) {
        throw ConfigError("config has no 'notification_channels' object");
    }

    NotificationRouter router;
    router.channels_.reserve(channels->object.keys.size());
    for (std::size_t index = 0; index < channels->object.keys.size(); ++index) {
        router.channels_.push_back(read_channel(channels->object.keys[index], channels->object.values[index]));
    }
    if (router.channels_.empty()) {
        throw ConfigError("'notification_channels' object contains no channels");
    }
    return router;
}

NotificationRouter NotificationRouter::from_file(const std::filesystem::path& config_path) {
    std::error_code error;
    if (!std::filesystem::is_regular_file(config_path, error)) {
        throw ConfigError("config file not found: " + config_path.string());
    }
    std::ifstream input{config_path, std::ios::binary};
    if (!input) {
        throw ConfigError("cannot open config file: " + config_path.string());
    }
    const std::string content{std::istreambuf_iterator<char>{input}, std::istreambuf_iterator<char>{}};
    try {
        return from_json(content);
    } catch (const ConfigError& exc) {
        throw ConfigError(config_path.string() + ": " + exc.what());
    }
}

bool NotificationRouter::has_channel(ChannelKind kind) const noexcept {
    return std::any_of(channels_.begin(), channels_.end(),
                       [kind](const NotificationChannel& item) { return item.kind == kind; });
}

const NotificationChannel& NotificationRouter::channel(ChannelKind kind) const {
    for (const NotificationChannel& item : channels_) {
        if (item.kind == kind) return item;
    }
    throw ConfigError("notification channel '" + std::string{to_string(kind)} + "' is not configured");
}

std::chrono::minutes NotificationRouter::moscow_time_of_day(TimePoint now_utc) {
    return moscow_time_of_day_impl(now_utc);
}

bool NotificationRouter::is_within_work_hours(ChannelKind kind, TimePoint now_utc) const {
    const NotificationChannel& item = channel(kind);
    if (!item.work_hours.enabled) return true;
    return item.work_hours.contains(moscow_time_of_day(now_utc));
}

RoutingDecision NotificationRouter::evaluate(ChannelKind kind, TimePoint now_utc) const {
    RoutingDecision decision;
    decision.channel = kind;
    decision.checked_at = now_utc;
    decision.moscow_time_of_day = moscow_time_of_day(now_utc);

    const NotificationChannel& item = channel(kind);
    if (!item.enabled) {
        decision.reason = "channel_disabled";
        return decision;
    }
    if (!is_within_work_hours(kind, now_utc)) {
        decision.reason = "outside_work_hours";
        return decision;
    }
    decision.allowed = true;
    decision.reason = "ok";
    return decision;
}

RoutingDecision NotificationRouter::dispatch(ChannelKind kind, std::string_view text, const Transport& transport,
                                             TimePoint now_utc) const {
    RoutingDecision decision = evaluate(kind, now_utc);
    if (!decision.allowed || !transport) return decision;

    decision.transport_called = true;
    try {
        decision.transport_exit_code = transport(channel(kind), text);
    } catch (const std::exception&) {
        // Сбой отправки не должен ронять ядро: фиксируем код -1 и причину.
        decision.transport_exit_code = -1;
        decision.reason = "transport_exception";
        return decision;
    }
    if (decision.transport_exit_code != 0) {
        decision.reason = "transport_failed";
    }
    return decision;
}

std::vector<std::string> NotificationRouter::build_sender_argv(ChannelKind kind, std::string_view text) const {
    const NotificationChannel& item = channel(kind);
    if (item.sender_script.empty()) {
        throw ConfigError("notification_channels." + std::string{to_string(kind)} + ".sender_script is empty");
    }
    std::vector<std::string> argv;
    argv.emplace_back(item.sender_script);
    argv.emplace_back(std::string{text});
    return argv;
}

std::string describe(const RoutingDecision& decision) {
    std::ostringstream out;
    out << "channel=" << to_string(decision.channel) << " allowed=" << (decision.allowed ? "true" : "false")
        << " reason=" << decision.reason << " msk=" << format_hh_mm(decision.moscow_time_of_day);
    if (decision.transport_called) {
        out << " transport_exit_code=" << decision.transport_exit_code;
    }
    if (decision.delivered()) {
        out << " status=delivered";
    }
    return out.str();
}

}  // namespace orchestrator





