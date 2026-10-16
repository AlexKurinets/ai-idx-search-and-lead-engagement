FROM python:3.12-slim
WORKDIR /app/services/ai
COPY services/ai/pyproject.toml ./
RUN python -c "import tomllib; p = tomllib.load(open('pyproject.toml', 'rb'))['project']; print('\n'.join(p['dependencies'] + p['optional-dependencies']['openai']))" > /tmp/requirements.txt \
    && pip install --no-cache-dir -r /tmp/requirements.txt
COPY data/geo /app/data/geo
COPY services/ai/app ./app
COPY services/ai/evals ./evals
ENV GEO_PATH=/app/data/geo/markets.json PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
