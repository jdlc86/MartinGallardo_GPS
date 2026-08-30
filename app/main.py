from app.bot import build_bot_application


def main() -> None:
    application = build_bot_application()
    application.run_polling(allowed_updates=None)


if __name__ == "__main__":
    main()
