FROM python:3.12-slim
WORKDIR /app/services/mls-sim
COPY services/mls-sim/pyproject.toml ./
RUN python -c "import tomllib; print('\n'.join(tomllib.load(open('pyproject.toml', 'rb'))['project']['dependencies']))" > /tmp/requirements.txt \
    && pip install --no-cache-dir -r /tmp/requirements.txt
COPY data/geo /app/data/geo
COPY services/mls-sim/app ./app
ENV GEO_PATH=/app/data/geo/markets.json PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
